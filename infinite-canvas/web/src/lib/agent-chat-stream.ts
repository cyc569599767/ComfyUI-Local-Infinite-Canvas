export type StreamDelta = { reasoning?: string; content?: string };
export type ToolCall = { id?: string; function?: { name?: string; arguments?: string; thoughtSignature?: string } };
export type ChatReply = { content: string; reasoning: string; toolCalls: ToolCall[]; providerMetadata?: Record<string, unknown> };

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;
const RESPONSE_HELP = "Check the chat-completions endpoint and model, then retry.";
type JsonObject = Record<string, unknown>;
type ToolDraft = { id?: string; name: string; arguments: string; thoughtSignature?: string };

/** Safe to display/store: never attach the original error or response as a cause. */
export function redactAgentError(message: string, apiKey?: string): string {
    let safe = message;
    if (apiKey) {
        // Literal replacement also handles keys containing regexp metacharacters.
        for (const key of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1), encodeURIComponent(apiKey)])) {
            if (key) safe = safe.split(key).join("[REDACTED]");
        }
    }
    safe = safe.replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]");
    safe = safe.replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]");
    safe = safe.replace(/\b(api[_-]?key|authorization)\s*[:=]\s*["']?[^\s,;"'<>]+/gi, "$1=[REDACTED]");
    safe = safe.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    return safe.length > 1024 ? `${safe.slice(0, 1024)}…` : safe;
}

function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(detail: string): Error {
    return new Error(`${detail} ${RESPONSE_HELP}`);
}

function contentText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    // Preserve the component's content-array behavior (including non-string text).
    return value.map((part) => (object(part) && "text" in part ? String(part.text || "") : "")).join("");
}

function reasoningText(message: JsonObject): string {
    const raw = message.reasoning_content ?? message.reasoning;
    return typeof raw === "string" ? raw : "";
}

function apiError(data: JsonObject): string | null {
    if (data.error === undefined || data.error === null || data.error === false) return null;
    if (typeof data.error === "string") return data.error || "The chat API returned an error.";
    if (object(data.error) && typeof data.error.message === "string") return data.error.message || "The chat API returned an error.";
    return "The chat API returned an error. Check the API key, model, and endpoint.";
}

function checkIndex(index: unknown): number {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS) {
        throw invalid("Invalid tool-call index: expected an integer from 0 to 127.");
    }
    return index;
}

function appendTools(value: unknown, drafts: Map<number, ToolDraft>): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) throw invalid("Invalid tool-call list (maximum 128 calls).");
    value.forEach((call, fallbackIndex) => {
        if (!object(call)) throw invalid("Invalid tool-call payload.");
        const index = checkIndex(call.index === undefined ? fallbackIndex : call.index);
        if (call.id !== undefined && typeof call.id !== "string") throw invalid("Invalid tool-call identifier.");
        if (call.function !== undefined && !object(call.function)) throw invalid("Invalid tool-call function.");
        const fn = object(call.function) ? call.function : {};
        if (fn.name !== undefined && typeof fn.name !== "string") throw invalid("Invalid tool-call name.");
        if (fn.arguments !== undefined && typeof fn.arguments !== "string") throw invalid("Invalid tool-call arguments.");
        const draft = drafts.get(index) ?? { name: "", arguments: "" };
        if (call.id) draft.id = call.id as string;
        if (fn.name) draft.name += fn.name as string;
        if (fn.arguments) draft.arguments += fn.arguments as string;
        if (fn.thoughtSignature !== undefined) {
            if (typeof fn.thoughtSignature !== "string") throw invalid("Invalid tool signature.");
            draft.thoughtSignature = fn.thoughtSignature;
        }
        drafts.set(index, draft);
    });
}

function finishTools(drafts: Map<number, ToolDraft>): ToolCall[] {
    return [...drafts.entries()].sort(([a], [b]) => a - b).map(([, draft]) => {
        if (!draft.name.trim()) throw invalid("Incomplete tool call: the API did not return a function name.");
        const args = draft.arguments || "{}";
        try {
            JSON.parse(args);
        } catch {
            throw invalid("Malformed or truncated tool-call JSON arguments.");
        }
        return { id: draft.id, function: { name: draft.name, arguments: args, ...(draft.thoughtSignature ? { thoughtSignature: draft.thoughtSignature } : {}) } };
    });
}

function messageReply(message: JsonObject): ChatReply {
    const drafts = new Map<number, ToolDraft>();
    appendTools(message.tool_calls, drafts);
    return { content: contentText(message.content), reasoning: reasoningText(message), toolCalls: finishTools(drafts),
        ...(object(message.provider_metadata) ? { providerMetadata: message.provider_metadata } : {}) };
}

function requireReply(reply: ChatReply): ChatReply {
    if (!reply.content && !reply.reasoning && !reply.toolCalls.length) throw invalid("The chat API returned an empty message.");
    return reply;
}

/** Parse an already-fetched response; this module performs no transport or persistence. */
export async function readAgentChatResponse(
    response: Response,
    { signal, onDelta, apiKey }: { signal?: AbortSignal; onDelta?: (delta: StreamDelta) => void; apiKey?: string } = {},
): Promise<ChatReply> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let eof = false;
    let cancelled = false;
    const abortError = () => new DOMException("The chat response was aborted.", "AbortError");
    const cancelReader = () => {
        if (!reader || cancelled || eof) return;
        cancelled = true;
        // Cancellation must not wait for a stalled underlying source's cleanup.
        try { void reader.cancel().catch(() => {}); } catch { /* Best-effort cleanup. */ }
    };
    // cancel() settles any pending read immediately even if source cleanup hangs.
    const onAbort = () => { cancelReader(); };
    const checkAbort = () => { if (signal?.aborted) throw abortError(); };

    try {
        reader = response.body?.getReader();
        signal?.addEventListener("abort", onAbort, { once: true });
        checkAbort();
        if (!reader) throw invalid(`The chat API returned an empty response${response.ok ? "" : ` (HTTP ${response.status})`}.`);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        const readText = async (): Promise<string | null> => {
            checkAbort();
            const result = await reader!.read();
            checkAbort();
            if (result.done) { eof = true; return null; }
            bytes += result.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw invalid("The chat response exceeded the 8 MiB limit. Request a shorter reply.");
            try { return decoder.decode(result.value, { stream: true }); }
            catch { throw invalid("The chat response contained invalid or truncated UTF-8."); }
        };
        const flushText = () => {
            try { return decoder.decode(); }
            catch { throw invalid("The chat response contained invalid or truncated UTF-8."); }
        };
        const emit = (reply: ChatReply) => {
            checkAbort();
            if (reply.reasoning) onDelta?.({ reasoning: reply.reasoning });
            checkAbort();
            if (reply.content) onDelta?.({ content: reply.content });
            checkAbort();
        };
        const isSse = /\btext\/event-stream\b/i.test(response.headers.get("content-type") || "");
        if (!isSse) {
            let text = "";
            for (;;) {
                const chunk = await readText();
                if (chunk === null) break;
                text += chunk;
            }
            text += flushText();
            let data: unknown;
            try { data = JSON.parse(text); }
            catch { throw invalid(response.ok ? "The chat API returned empty, malformed, or truncated JSON." : `The chat API failed (HTTP ${response.status}).`); }
            if (!object(data)) throw invalid(`Invalid chat response${response.ok ? "" : ` (HTTP ${response.status})`}.`);
            const error = apiError(data);
            if (error !== null) throw new Error(error);
            if (!response.ok) {
                const detail = typeof data.message === "string" ? ` ${data.message}` : "";
                throw new Error(`The chat API failed (HTTP ${response.status}).${detail} ${RESPONSE_HELP}`);
            }
            const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
            if (!object(choice) || !object(choice.message)) throw invalid("The chat API returned no message choices.");
            const reply = requireReply(messageReply(choice.message));
            emit(reply);
            return reply;
        }

        let buffer = "";
        let pendingData: string[] = [];
        let eventName = "";
        let finished = false;
        let sawChoice = false;
        let content = "";
        let reasoning = "";
        let fallback: JsonObject | undefined;
        let providerMetadata: JsonObject | undefined;
        const drafts = new Map<number, ToolDraft>();
        const accept = (data: unknown) => {
            if (!object(data)) throw invalid("Invalid JSON object in the chat event stream.");
            const error = apiError(data);
            if (error !== null) throw new Error(error);
            if (eventName === "error") throw new Error(typeof data.message === "string" ? data.message : "The chat API returned a stream error.");
            if (!response.ok) throw new Error(`The chat API failed (HTTP ${response.status}). ${RESPONSE_HELP}`);
            if (!Array.isArray(data.choices)) throw invalid("The chat event stream returned no choices.");
            // Some APIs send an empty choices array with the final usage report.
            if (!data.choices.length) return;
            const choice = data.choices[0];
            if (!object(choice)) throw invalid("Invalid choice in the chat event stream.");
            const delta = choice.delta;
            if (delta !== undefined && delta !== null && !object(delta)) throw invalid("Invalid chat stream delta.");
            if (object(delta)) {
                sawChoice = true;
                if (object(delta.provider_metadata)) providerMetadata = { ...providerMetadata, ...delta.provider_metadata };
                const nextReasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
                const nextContent = contentText(delta.content);
                appendTools(delta.tool_calls, drafts);
                reasoning += nextReasoning;
                content += nextContent;
                emit({ content: nextContent, reasoning: nextReasoning, toolCalls: [] });
            } else if (object(choice.message)) {
                sawChoice = true;
                fallback = choice.message;
            } else if (typeof choice.finish_reason !== "string") {
                throw invalid("The chat event stream returned an invalid message choice.");
            }
        };
        const dispatch = (final: boolean) => {
            if (!pendingData.length) return;
            const payload = pendingData.join("\n").trim();
            if (!payload) { pendingData = []; return; }
            if (payload === "[DONE]") { pendingData = []; finished = true; return; }
            let data: unknown;
            try { data = JSON.parse(payload); }
            catch {
                if (!final) return; // A standard SSE event may have multiple data lines.
                throw invalid("Malformed or truncated JSON in the chat event stream.");
            }
            accept(data);
            pendingData = [];
            eventName = "";
        };
        const line = (raw: string) => {
            const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
            if (!value) { dispatch(true); eventName = ""; return; }
            if (value.startsWith(":")) return;
            const colon = value.indexOf(":");
            const field = colon < 0 ? value : value.slice(0, colon);
            const rawData = colon < 0 ? "" : value.slice(colon + 1);
            const data = rawData.startsWith(" ") ? rawData.slice(1) : rawData;
            if (field === "event") eventName = data;
            if (field === "data") {
                pendingData.push(data);
                // Also accept APIs delimiting complete JSON frames with a single LF.
                dispatch(false);
            }
        };
        for (;;) {
            const chunk = await readText();
            if (chunk === null) buffer += flushText();
            else buffer += chunk;
            let start = 0;
            let newline: number;
            while (!finished && (newline = buffer.indexOf("\n", start)) >= 0) {
                line(buffer.slice(start, newline));
                start = newline + 1;
            }
            buffer = buffer.slice(start);
            if (finished) break;
            if (chunk === null) {
                if (buffer) line(buffer);
                if (!finished) dispatch(true);
                break;
            }
        }
        checkAbort();
        if (!response.ok) throw new Error(`The chat API failed (HTTP ${response.status}). ${RESPONSE_HELP}`);
        if (!sawChoice) throw invalid("The chat event stream returned no message choices.");
        // Valid APIs sometimes close after their last choice without a [DONE] frame.
        if (!content && !reasoning && !drafts.size && fallback) {
            const reply = requireReply(messageReply(fallback));
            emit(reply);
            return reply;
        }
        return requireReply({ content, reasoning, toolCalls: finishTools(drafts), ...(providerMetadata ? { providerMetadata } : {}) });
    } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        const message = error instanceof Error ? error.message : `Could not read the chat response. ${RESPONSE_HELP}`;
        throw new Error(redactAgentError(message, apiKey));
    } finally {
        signal?.removeEventListener("abort", onAbort);
        cancelReader();
        reader?.releaseLock();
    }
}

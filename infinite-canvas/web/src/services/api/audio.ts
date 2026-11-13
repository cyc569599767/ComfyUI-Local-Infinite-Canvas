import axios from "axios";

import i18n from "@/i18n";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioModeValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, type CanvasAudioMode } from "@/lib/audio-generation";
import { trimLeadingSilence } from "@/lib/audio-trim";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { localGatewayRoot } from "@/services/api/image";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal };

export type AudioGenerationRequest = {
    /** 三种模式共用的「文案」：音色设计/克隆是朗读文案，音乐是 caption。 */
    prompt: string;
    voiceDescription?: string;
    lyrics?: string;
    language?: string;
    maxDuration?: string;
    seed?: string;
    seedFixed?: string;
    /** 音色克隆的参考音频（画布上连入的音频节点）。 */
    referenceAudio?: Blob | string;
};

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/**
 * 最近一次本地音频生成的告警（例如音色描述缺失走了兜底）。
 * 生成是阻塞调用，调用方读完即清空，避免把上一次的告警带到下一次。
 */
let lastAudioWarnings: string[] = [];

export function takeAudioWarnings(): string[] {
    const warnings = lastAudioWarnings;
    lastAudioWarnings = [];
    return warnings;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

/** 本地网关走 /v1/audio/speech，按 mode 分发到音色设计 / 音色克隆 / 音乐生成。 */
export async function requestLocalAudioGeneration(config: AiConfig, mode: CanvasAudioMode, request: AudioGenerationRequest, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const root = localGatewayRoot(requestConfig.baseUrl);
    if (!root) throw new Error(apiText("audioLocalGatewayOnly"));
    if (!model) throw new Error(apiText("audioModelRequired"));

    const formData = new FormData();
    formData.set("model", model);
    formData.set("mode", mode);
    formData.set("input", request.prompt);
    formData.set("response_format", "b64_json");
    if (request.voiceDescription?.trim()) formData.set("voice_description", request.voiceDescription.trim());
    if (mode === "music") {
        formData.set("lyrics", request.lyrics ?? "");
        formData.set("max_duration", request.maxDuration || "60");
    }
    if (request.language) formData.set("language", request.language);
    const params: Record<string, unknown> = {};
    if (request.seed?.trim()) params.seed = request.seed.trim();
    if (Object.keys(params).length) formData.set("params", JSON.stringify(params));

    if (mode === "voice-clone") {
        if (!request.referenceAudio) throw new Error(apiText("audioReferenceRequired"));
        const raw = await resolveReferenceAudioBlob(request.referenceAudio);
        // 参考音频开头若有前导静音，克隆会把它复刻成「嗯」这类气口；
        // 先裁掉前导再上传，实测可把多余音节从 5/6 降到 0/6。
        const { blob } = await trimLeadingSilence(raw);
        formData.append("audios", blob, `reference.${audioExtension(blob.type)}`);
    }

    let response;
    try {
        response = await axios.post<{ data?: Array<{ b64_json?: string; url?: string }>; mime_type?: string; warnings?: string[] }>(`${root}/v1/audio/speech`, formData, {
            headers: { Authorization: `Bearer ${requestConfig.apiKey}` },
            signal: options?.signal,
            timeout: 30 * 60 * 1000,
        });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }
    // 音色描述缺失时网关用中性兜底生成；要让用户知道音色偏中性是缺描述导致的。
    if (mode === "voice-design" && Array.isArray(response.data?.warnings) && response.data.warnings.includes("voice_description_fallback")) {
        lastAudioWarnings.push(i18n.t("apiErrors.audioVoiceDescriptionFallback"));
    }
    const item = response.data?.data?.[0];
    const mimeType = response.data?.mime_type || "audio/flac";
    if (!item) throw new Error(apiText("audioGenerationFailed"));
    if (item.b64_json) {
        const bytes = base64ToBytes(item.b64_json);
        return new Blob([bytes], { type: mimeType });
    }
    if (item.url) {
        const blob = await (await fetch(withLocalProxy(item.url))).blob();
        return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: mimeType });
    }
    throw new Error(apiText("audioGenerationFailed"));
}

/**
 * 参考音频可能以三种形态出现：已加载的 Blob、localforage 的 storageKey
 * （形如 "audio:xxxx"，不是 URL）、或可 fetch 的 http/blob/data URL。
 * storageKey 必须走 media store 取回，直接 fetch 会 404。
 */
export async function resolveReferenceAudioBlob(reference: Blob | string): Promise<Blob> {
    if (typeof reference !== "string") return reference;
    if (/^(https?:|blob:|data:)/i.test(reference)) {
        return (await fetch(withLocalProxy(reference))).blob();
    }
    const stored = await getMediaBlob(reference);
    if (!stored) throw new Error(apiText("audioReferenceUnavailable"));
    return stored;
}

export function audioExtension(mimeType: string) {
    // ComfyUI 的 /view 对 FLAC 回的是 audio/x-flac，必须一起认。
    if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "wav";
    if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "mp3";
    if (mimeType === "audio/ogg") return "ogg";
    if (mimeType === "audio/opus") return "opus";
    return "flac";
}

function base64ToBytes(value: string) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    const script = resolveModelScript(config, config.model || config.audioModel);
    if (script) {
        if (!model) throw new Error(apiText("audioModelRequired"));
        if (!requestConfig.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
        if (!requestConfig.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
        try {
            const result = await runModelPlugin({
                capability: "audio",
                script,
                config: requestConfig,
                prompt,
                params: { voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: normalizeAudioSpeedValue(config.audioSpeed), instructions: config.audioInstructions.trim() },
                signal: options?.signal,
            });
            return await audioPluginBlob(result, format);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }
    assertAudioConfig(requestConfig, model);
    const instructions = config.audioInstructions.trim();

    try {
        const response = await axios.post<Blob>(
            aiApiUrl(requestConfig, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }
}

async function audioPluginBlob(result: unknown, format: string): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error(apiText("scriptNoAudio"));
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const blob = await (await fetch(withLocalProxy(url))).blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

/**
 * 画布音频节点的统一入口：
 * - 本地网关渠道 → /v1/audio/speech（音色设计 / 音色克隆 / 音乐生成）
 * - 其它渠道 → 原来的 OpenAI 兼容 /audio/speech（仅音色设计）
 */
export async function generateCanvasAudio(config: AiConfig, mode: CanvasAudioMode, request: AudioGenerationRequest, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    if (localGatewayRoot(requestConfig.baseUrl)) {
        return requestLocalAudioGeneration(config, normalizeAudioModeValue(mode), request, options);
    }
    if (normalizeAudioModeValue(mode) !== "voice-design") {
        throw new Error(apiText("audioLocalGatewayOnly"));
    }
    return requestAudioGeneration(config, request.prompt, options);
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("audioModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiAudioUnsupported"));
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("audioGenerationFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/^\s*<(!doctype\s+html|html[\s>])/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        const statusMsg = statusMessage(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

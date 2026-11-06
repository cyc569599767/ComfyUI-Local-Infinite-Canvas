import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";
import { normalizeAgentBaseUrl, type AgentCloudProfile, type AgentRuntime } from "@/lib/agent-cloud-config";

function safeError(value: string, apiKey: string) {
    let result = String(value || "请求失败");
    if (apiKey) result = result.split(apiKey).join("[redacted]");
    return result.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]").slice(0, 600);
}

// Only the local gateway receives the key; it forwards it once in Authorization,
// never in a URL. Cloud CORS settings do not affect this transport.
export async function requestAgentCloud(
    operation: "models" | "chat",
    profile: Pick<AgentCloudProfile, "baseUrl" | "apiKey" | "apiFormat">,
    request?: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Response> {
    const baseUrl = normalizeAgentBaseUrl(profile.baseUrl, profile.apiFormat);
    const response = await fetch(`${LOCAL_GATEWAY_ORIGIN}/api/agent/cloud/${operation}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey: profile.apiKey.trim(), apiFormat: profile.apiFormat || "openai", ...(request ? { request } : {}) }),
        signal, cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
        let message = `云端 API 请求失败（HTTP ${response.status}）`;
        try {
            const data = await response.json() as { error?: { message?: string } };
            if (typeof data.error?.message === "string") message = data.error.message;
        } catch { /* Do not expose HTML/error pages which may echo credentials. */ }
        if (response.status === 404) message = "本地网关尚未支持云端 Agent 接口，请更新并重启桌面端。";
        throw new Error(safeError(message, profile.apiKey));
    }
    return response;
}

export async function fetchAgentCloudModels(profile: Pick<AgentCloudProfile, "baseUrl" | "apiKey" | "apiFormat">, options: { signal?: AbortSignal } = {}): Promise<string[]> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const response = await requestAgentCloud("models", profile, undefined, signal);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(data.data)) throw new Error("接口未返回 OpenAI 兼容模型列表；可手动填写模型名并发送对话。");
    return [...new Set(data.data.flatMap(item => typeof item?.id === "string" && item.id.trim() ? [item.id] : []))].slice(0, 2000);
}

export async function requestAgentChat(runtime: AgentRuntime, request: Record<string, unknown>, signal: AbortSignal) {
    if (runtime.transport === "cloud") return requestAgentCloud("chat", runtime, request, signal);
    return fetch(`${normalizeAgentBaseUrl(runtime.baseUrl)}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request), signal, redirect: "error", cache: "no-store",
    });
}

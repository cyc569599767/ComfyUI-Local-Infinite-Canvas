export type AgentTransport = "cloud" | "local";
export type AgentApiFormat = "openai" | "responses" | "gemini" | "anthropic" | "grok";
export const AGENT_API_FORMATS: AgentApiFormat[] = ["openai", "responses", "gemini", "anthropic", "grok"];
export function normalizeAgentApiFormat(value: unknown): AgentApiFormat {
    return AGENT_API_FORMATS.includes(value as AgentApiFormat) ? value as AgentApiFormat : "openai";
}
export type AgentCloudProfile = { baseUrl: string; apiKey: string; model: string; rememberKey?: boolean; apiFormat?: AgentApiFormat };
export type AgentConnectionSettings = { transport: AgentTransport; enabled: boolean; localBaseUrl: string };
export type AgentRuntime = AgentCloudProfile & { transport: AgentTransport; developer: boolean };

// Accept an origin, API base (including compatible-mode paths), or full chat URL.
// Never let credentials leak through URL query strings or userinfo.
export function normalizeAgentBaseUrl(raw: string, apiFormat: AgentApiFormat = "openai"): string {
    const value = String(raw || "").trim();
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("请输入有效的模型 API URL。"); }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("云端 API 必须使用 HTTPS；只有本机回环地址允许 HTTP。");
    if (url.username || url.password || url.search || url.hash || /[\\?#]/.test(value) || /\/\//.test(url.pathname)) throw new Error("API URL 不能包含用户名、密码、查询参数或片段，请将 Key 填入独立字段。");
    if (host === "localhost") url.hostname = "127.0.0.1";
    const originalPath = url.pathname.replace(/\/+$/, "");
    // Strip only known operation suffixes, retaining provider-specific base paths.
    url.pathname = originalPath
        .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "")
        .replace(/\/(?:chat\/completions|responses|messages|models)$/i, "");
    if (!url.pathname || url.pathname === "/") url.pathname = apiFormat === "gemini" ? "/v1beta" : "/v1";
    return url.toString().replace(/\/+$/, "");
}

export function resolveAgentRuntime(settings: AgentConnectionSettings, profile: AgentCloudProfile | null): AgentRuntime {
    if (settings.transport === "local") {
        const baseUrl = normalizeAgentBaseUrl(settings.localBaseUrl);
        const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
        if (host !== "localhost" && host !== "::1" && !/^127\.\d+\.\d+\.\d+$/.test(host)) throw new Error("本地 pi 模式只接受本机回环地址。");
        return { transport: "local", baseUrl, apiKey: "", model: settings.enabled ? "openclaw/canvas-dev" : "openclaw/canvas-agent", developer: settings.enabled };
    }
    if (!profile?.baseUrl.trim() || !profile.model.trim() || !profile.apiKey.trim()) throw new Error("请先配置云端 API URL、API Key 和模型名称。");
    const apiFormat = normalizeAgentApiFormat(profile.apiFormat);
    return { transport: "cloud", baseUrl: normalizeAgentBaseUrl(profile.baseUrl, apiFormat), apiKey: profile.apiKey.trim(), model: profile.model.trim(), apiFormat, developer: false };
}

// Keep unremembered keys only in the in-memory store. Existing profiles without
// this new preference retain their old persistence behavior until edited.
export function persistedPromptCloudConfig<T extends {
    promptCloudApis?: Array<AgentCloudProfile & { id: string }>;
    promptCloudApiId?: string; promptCloudApiKey?: string;
}>(config: T): T {
    const apis = config.promptCloudApis?.map(api => ({ ...api, apiKey: api.rememberKey === false ? "" : api.apiKey }));
    if (!apis) return config;
    const active = apis.find(api => api.id === config.promptCloudApiId) || apis[0];
    return { ...config, promptCloudApis: apis, promptCloudApiKey: active?.apiKey || "" };
}

import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { resolveMediaUrl } from "@/services/file-storage";
import { gatewayFetch } from "@/services/api/gateway-status";

const GATEWAY_ROOT = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

type Signal = { signal?: AbortSignal };

// 网关音频错误码 → 中文兜底文案（与网关 server.js/audio-local.js 同源）；网关原文已含详情（缺依赖清单/安装指引/显存读数）时优先用网关原文。
const AUDIO_ERROR_TEXT: Record<string, string> = {
    missing_prompt: "缺少歌词或主题",
    invalid_lyrics: "YuE2 歌词需要 [Verse] 和 [Chorus] 段落；请先让 AI 写词或按官方格式补齐",
    unsupported_reference_audio: "YuE2 写歌不支持参考音色；参考音色仅用于换声",
    missing_reference_audio: "台词生成需要参考音色，请先上传 3–15 秒参考音频",
    missing_text: "台词文本不能为空",
    text_too_long: "台词过长：H3 单段约 15 秒上限，请拆成多段",
    unsupported_language: "H3 语音不支持该语言",
    audio_busy: "已有音频任务在跑，请稍后再试",
    insufficient_vram: "显存不足，请释放显存后重试",
    audio_engine_missing: "音频运行环境缺失，请按提示安装后重试",
    audio_model_missing: "YuE2 模型未安装：请安装 int8 checkpoint 后重试",
    audio_instrumental_node_missing: "纯音乐转换节点未加载：请重启 ComfyUI 后重试",
    audio_timeout: "音频任务超时，请重试",
    audio_engine_failed: "音频引擎执行失败",
    audio_output_missing: "引擎没有产出音频文件，请检查运行日志",
    invalid_lyrics_duration: "歌词行数与目标时长不匹配，请先优化歌词或调整时长",
    invalid_precision: 'precision 只支持 "fast" 或 "quality"',
};

async function audioError(response: Response): Promise<Error> {
    let message = `HTTP ${response.status}`;
    try {
        const data = (await response.json()) as { error?: string | { message?: string; code?: string }; message?: string };
        if (typeof data.error === "string") message = data.error;
        else if (data.error?.message) message = data.error.message;
        else if (data.message) message = data.message;
        else if (typeof data.error === "object" && data.error?.code && AUDIO_ERROR_TEXT[data.error.code]) message = AUDIO_ERROR_TEXT[data.error.code];
    } catch {
        // 非 JSON 错误体保留状态码。
    }
    return new Error(message);
}

// 同步接口：默认返回音频二进制；response_format=b64_json 时解 base64。无任务契约，不做轮询/进度条。
async function readAudioBlob(response: Response, mimeType: string, fallback: string): Promise<Blob> {
    if ((response.headers.get("content-type") || "").includes("application/json")) {
        const data = (await response.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string }> };
        const b64 = data.data?.[0]?.b64_json || "";
        if (!b64) throw new Error(`${fallback}：网关没有返回音频`);
        return new Blob([Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))], { type: mimeType });
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error(`${fallback}：网关没有返回音频`);
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: mimeType });
}

async function postAudioForm(path: string, form: FormData, mimeType: string, fallback: string, signal?: AbortSignal): Promise<Blob> {
    let response: Response;
    try {
        response = await gatewayFetch(`${GATEWAY_ROOT}${path}`, { method: "POST", body: form, signal });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(`${fallback}：无法连接本地网关（${GATEWAY_ROOT}）`);
    }
    if (!response.ok) throw await audioError(response);
    return readAudioBlob(response, mimeType, fallback);
}

export async function requestLyricsOptimize(idea: string, style: string, duration: string, options?: Signal): Promise<string> {
    const form = new FormData();
    form.set("task", "lyrics");
    form.set("prompt", idea);
    form.set("style", style);
    form.set("duration", duration);
    let response: Response;
    try {
        response = await gatewayFetch(`${GATEWAY_ROOT}/v1/prompts/optimize`, { method: "POST", body: form, signal: options?.signal });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(`歌词优化失败：无法连接本地网关（${GATEWAY_ROOT}）`);
    }
    const data = (await response.json().catch(() => ({}))) as { lyrics?: string; error?: string | { message?: string }; message?: string };
    if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : data.error?.message || data.message || `HTTP ${response.status}`;
        throw new Error(message);
    }
    const lyrics = String(data.lyrics || "").trim();
    if (!lyrics) throw new Error("歌词优化返回为空");
    return lyrics;
}

export async function requestYue2Song(idea: string, style: string, seed: string, duration: string, options?: Signal & { bpm?: string; language?: string; keyscale?: string; gender?: string; precision?: string }): Promise<Blob> {
    // 画布会把上游文本块编号成「【文本N】」，歌词不能带这层编号（与网关 stripCanvasTextLabels 同源）。
    const lyrics = String(idea || "").replace(/(^|\n)\s*【文本\s*\d+】\s*/g, "$1").trim();
    const styleText = String(style || "").trim();
    if (!lyrics && !styleText) throw new Error("缺少歌词或风格");
    const instrumental = !lyrics;
    const form = new FormData();
    form.set("lyrics", lyrics);
    form.set("tags", style);
    form.set("instrumental", instrumental ? "true" : "false");
    if (seed) form.set("seed", seed);
    if (duration !== undefined && duration !== null && duration !== "") form.set("duration", duration);
    const bpm = Number(options?.bpm);
    if (Number.isFinite(bpm) && bpm > 0) form.set("bpm", String(Math.trunc(bpm)));
    const language = String(options?.language || "").trim();
    if (language) form.set("language", language);
    const keyscale = String(options?.keyscale || "").trim();
    if (keyscale) form.set("keyscale", keyscale);
    const precision = String(options?.precision || "").trim();
    if (precision) form.set("precision", precision);
    const gender = String(options?.gender || "").trim().toLowerCase();
    if (gender === "male" || gender === "female") form.set("gender", gender);
    return postAudioForm("/v1/audio/song", form, "audio/flac", "写歌失败", options?.signal);
}

/** 台词：IndexTTS-2 零样本克隆（需要参考音色）。 */
export async function requestIndexttsSpeech(text: string, reference: { blob: Blob; name: string }, options?: Signal & { instructions?: string; speed?: string; seed?: string }): Promise<Blob> {
    const form = new FormData();
    form.set("input", text);
    form.set("reference_audio", reference.blob, reference.name || "reference.wav");
    const instructions = String(options?.instructions || "").trim();
    if (instructions) form.set("instructions", instructions);
    const speed = String(options?.speed || "").trim();
    if (speed) form.set("speed", speed);
    const seedValue = String(options?.seed || "").trim();
    if (seedValue) form.set("seed", seedValue);
    return postAudioForm("/v1/audio/speech-indextts", form, "audio/wav", "台词生成失败", options?.signal);
}

/** 台词：MiniMax H3 描述音色语音（不需要参考音频，单段约 15 秒）。 */
export async function requestH3Speech(text: string, options?: Signal & { voiceDescription?: string; instructions?: string; language?: string; seed?: string }): Promise<Blob> {
    let response: Response;
    try {
        response = await gatewayFetch(`${GATEWAY_ROOT}/v1/audio/speech-h3`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                input: text,
                voice_description: options?.voiceDescription || "",
                instructions: options?.instructions || "",
                language: options?.language || "zh",
                ...(options?.seed ? { seed: Number(options.seed) } : {}),
            }),
            signal: options?.signal,
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(`H3 语音失败：无法连接本地网关（${GATEWAY_ROOT}）`);
    }
    if (!response.ok) throw await audioError(response);
    return readAudioBlob(response, "audio/wav", "H3 语音失败");
}

export async function loadAudioBlob(ref: { url?: string; storageKey?: string; name?: string } | undefined, signal?: AbortSignal): Promise<{ blob: Blob; name: string } | null> {
    if (!ref) return null;
    const url = ref.storageKey ? await resolveMediaUrl(ref.storageKey) : ref.url;
    if (!url) return null;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("音频读取失败");
    return { blob: await response.blob(), name: ref.name || "audio" };
}
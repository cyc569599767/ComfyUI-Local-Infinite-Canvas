import axios from "axios";

import { localGatewayRoot } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * 故事分镜导演台的数据接口。
 *
 * 分镜表是长周期编辑的产物（一段故事拆几十镜、逐镜改提示词），
 * 所以落网关而不是浏览器：换浏览器、清缓存、换设备都不能丢。
 */

export type StoryboardAsset = {
    id: string;
    name: string;
    kind?: "character" | "scene" | "prop";
    role?: string;
    appearance?: string;
    wardrobe?: string;
    time?: string;
    weather_environment?: string;
    spatial_structure?: string;
    fixed_visuals?: string;
    category?: string;
    image_prompt?: string;
    negative_prompt?: string;
    image_url?: string;
    image_storage_key?: string;
};

export type StoryboardShot = {
    id: string;
    selected: boolean;
    title: string;
    duration: number;
    shot_type: string;
    camera_angle: string;
    story_beat: string;
    opening_state: string;
    action_progression: string;
    ending_state: string;
    dialogue: string;
    positive: string;
    negative: string;
    first_frame_prompt?: string;
    last_frame_prompt?: string;
    video_mode: string;
    protagonist_refs: string[];
    supporting_refs: string[];
    prop_refs: string[];
    scene_ref: string;
    image_url?: string;
    image_storage_key?: string;
    video_url?: string;
    video_storage_key?: string;
    /** 本项目的生成状态，网关不强制，前端用来显示进度。 */
    status?: "idle" | "queued" | "running" | "done" | "failed";
    error?: string;
};

export type StoryboardProject = {
    id: string;
    version: number;
    project: {
        name: string;
        story: string;
        style: string;
        aspect_ratio: string;
        max_shot_seconds: number;
        target_shot_count: number;
        negative_prompt: string;
        video_model: string;
        image_model: string;
    };
    characters: StoryboardAsset[];
    scenes: StoryboardAsset[];
    props: StoryboardAsset[];
    story_beats: Array<{ id: string; summary: string; act: string }>;
    shots: StoryboardShot[];
    active_shot_id: string;
    selection_mode: string;
    createdAt: string;
    updatedAt: string;
};

export type StoryboardSummary = { id: string; name: string; shotCount: number; createdAt: string; updatedAt: string };

function gatewayBase(config: AiConfig) {
    const root = localGatewayRoot(config.baseUrl);
    if (!root) throw new Error("当前不是本地网关渠道，分镜导演台需要连接本地网关");
    return root;
}

/**
 * 把网关的结构化错误翻译成人话。
 *
 * 网关已经把「云端 API 失败：Not found: POST /v1/chat/completions」这类原因写在
 * body.error.message 里，axios 却只抛出「Request failed with status code 502」。
 * 用户看到后者完全无从下手，所以这里必须把原始 message 提出来。
 */
function toReadableError(cause: unknown): never {
    if (axios.isAxiosError(cause)) {
        const payload = cause.response?.data as { error?: { message?: string; code?: string } } | undefined;
        const message = payload?.error?.message;
        if (message) throw new Error(message);
        if (cause.code === "ECONNABORTED") throw new Error("分镜拆解超时，请缩短故事或稍后重试");
        if (!cause.response) throw new Error("连不上本地网关，请确认网关正在运行");
    }
    throw cause instanceof Error ? cause : new Error(String(cause));
}

function client(config: AiConfig) {
    const base = gatewayBase(config);
    const wrap = <T>(request: Promise<{ data: T }>) => request.then((res) => res.data).catch(toReadableError);
    return {
        get: <T>(path: string) => wrap<T>(axios.get<T>(`${base}${path}`, { timeout: 30000 })),
        post: <T>(path: string, body: unknown, timeout = 30000) => wrap<T>(axios.post<T>(`${base}${path}`, body, { timeout })),
        put: <T>(path: string, body: unknown) => wrap<T>(axios.put<T>(`${base}${path}`, body, { timeout: 30000 })),
        delete: <T>(path: string) => wrap<T>(axios.delete<T>(`${base}${path}`, { timeout: 15000 })),
    };
}

export async function listStoryboardProjects(config: AiConfig) {
    return (await client(config).get<{ projects: StoryboardSummary[] }>("/api/storyboards")).projects;
}

export async function getStoryboardProject(config: AiConfig, id: string) {
    return (await client(config).get<{ project: StoryboardProject }>(`/api/storyboards/${encodeURIComponent(id)}`)).project;
}

export async function saveStoryboardProject(config: AiConfig, project: Partial<StoryboardProject> & { id?: string }) {
    const api = client(config);
    const body = { project };
    return project.id
        ? (await api.put<{ project: StoryboardProject }>(`/api/storyboards/${encodeURIComponent(project.id)}`, body)).project
        : (await api.post<{ project: StoryboardProject }>("/api/storyboards", body)).project;
}

export async function deleteStoryboardProject(config: AiConfig, id: string) {
    await client(config).delete(`/api/storyboards/${encodeURIComponent(id)}`);
}

/** 导出成 ComfyUI 原生导演台能直接粘贴的 storyboard_json。 */
export async function exportStoryboardComfyJson(config: AiConfig, id: string) {
    return (await client(config).get<{ storyboardJson: string }>(`/api/storyboards/${encodeURIComponent(id)}/comfy-json`)).storyboardJson;
}

export type StoryboardBreakdownInput = {
    story: string;
    style?: string;
    maxShotSeconds?: number;
    targetShotCount?: number;
    /** local = 本机 ComfyUI 的 llama.cpp；cloud = 配置里的云端模型。默认 local。 */
    engine?: "local" | "cloud";
};

export type StoryboardBreakdownResult = {
    style: string;
    beats: Array<{ id: string; summary: string; act: string }>;
    characters: StoryboardAsset[];
    scenes: StoryboardAsset[];
    props: StoryboardAsset[];
    shots: Array<Partial<StoryboardShot> & { id: string; positive: string }>;
    /** local = 本机 llama.cpp，cloud = 云端。 */
    provider?: "local" | "cloud";
    /** 输出被 token 上限截断，镜头数比预期少；已抢救出完整的那部分。 */
    truncated?: boolean;
};

/**
 * 默认走本机 ComfyUI 的 llama.cpp：本地渠道没有 chat 接口，
 * 让用户先配云端 key 才能拆解等于把功能锁死。只有显式 engine=cloud 才走云端。
 */
export async function breakdownStoryboard(config: AiConfig, input: StoryboardBreakdownInput) {
    const cloud = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, apiFormat: config.apiFormat };
    // 本机首次要加载 GGUF（约 5.7GB），给足 10 分钟；云端拆几十镜给 3 分钟。
    const engine = input.engine === "cloud" ? "cloud" : "local";
    const timeout = engine === "cloud" ? 180000 : 600000;
    return (await client(config).post<{ board: StoryboardBreakdownResult }>("/api/storyboards/breakdown", { ...input, engine, cloud }, timeout)).board;
}

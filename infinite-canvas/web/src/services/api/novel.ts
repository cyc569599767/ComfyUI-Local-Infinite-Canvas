import axios from "axios";

import { localGatewayRoot } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * 「无限・卷轴」的数据接口。
 *
 * 小说是长周期编辑的产物（几十万字正文、跨卷角色设定），
 * 所以落网关而不是浏览器：清缓存、换设备都不能丢。
 */

export type NovelChapter = {
    id: string;
    seq: number;
    title: string;
    volume: number;
    outline: string;
    novel: string;
    status: "pending" | "outlined" | "writing" | "done";
};

export type NovelVolume = {
    id: string;
    seq: number;
    title: string;
    outline: string;
    chapterFrom: number;
    chapterTo: number;
};

export type NovelCharacter = {
    id: string;
    name: string;
    role: string;
    description: string;
    notes?: string;
};

export type NovelMemory = {
    id: string;
    content: string;
    source?: string;
    createdAt: string;
};

export type NovelStructure = {
    outline: string;
    volumes: string;
    chapters: string;
};

export type NovelProject = {
    id: string;
    name: string;
    idea: string;
    createdAt: string;
    updatedAt: string;
    structure: NovelStructure;
    characters: NovelCharacter[];
    memory: NovelMemory[];
    volumes: NovelVolume[];
    chapters: NovelChapter[];
};

export type NovelSummary = {
    id: string;
    name: string;
    idea: string;
    chapterCount: number;
    wordCount: number;
    volumeCount: number;
    createdAt: string;
    updatedAt: string;
};

function gatewayBase(config: AiConfig) {
    const root = localGatewayRoot(config.baseUrl || "");
    if (!root) throw new Error("当前不是本地网关渠道，需要先连接本地网关");
    return root;
}

/** 把网关的结构化错误翻成人话，别让用户只看到 "Request failed with status code 502"。 */
function toReadableError(cause: unknown): never {
    if (axios.isAxiosError(cause)) {
        const payload = cause.response?.data as { error?: { message?: string } } | undefined;
        const message = payload?.error?.message;
        if (message) throw new Error(message);
        if (cause.code === "ECONNABORTED") throw new Error("生成超时，请稍后重试");
        if (!cause.response) throw new Error("连不上本地网关，请确认网关正在运行");
    }
    throw cause instanceof Error ? cause : new Error(String(cause));
}

function client(config: AiConfig) {
    const base = gatewayBase(config);
    const wrap = <T>(request: Promise<{ data: T }>) => request.then((res) => res.data).catch(toReadableError);
    return {
        get: <T>(path: string) => wrap<T>(axios.get<T>(`${base}${path}`, { timeout: 30000 })),
        // 生成是长任务：本地模型写一章可能要几分钟，超时必须放宽。
        post: <T>(path: string, body: unknown, timeout = 30000) => wrap<T>(axios.post<T>(`${base}${path}`, body, { timeout })),
        put: <T>(path: string, body: unknown) => wrap<T>(axios.put<T>(`${base}${path}`, body, { timeout: 30000 })),
        delete: <T>(path: string) => wrap<T>(axios.delete<T>(`${base}${path}`, { timeout: 15000 })),
    };
}

/** 生成类请求的超时：10 分钟，覆盖本地模型冷加载 + 长推理。 */
const GENERATE_TIMEOUT = 600000;

export async function listNovels(config: AiConfig) {
    return (await client(config).get<{ novels: NovelSummary[] }>("/api/novels")).novels;
}

export async function getNovel(config: AiConfig, id: string) {
    return (await client(config).get<{ novel: NovelProject }>(`/api/novels/${encodeURIComponent(id)}`)).novel;
}

export async function createNovel(config: AiConfig, input: { name?: string; idea?: string }) {
    return (await client(config).post<{ novel: NovelProject }>("/api/novels", input)).novel;
}

export async function saveNovel(config: AiConfig, id: string, patch: Partial<NovelProject>) {
    return (await client(config).put<{ novel: NovelProject }>(`/api/novels/${encodeURIComponent(id)}`, patch)).novel;
}

export async function deleteNovel(config: AiConfig, id: string) {
    await client(config).delete(`/api/novels/${encodeURIComponent(id)}`);
}

export type NovelGenerateInput = {
    step: "outline" | "volumes" | "chapters" | "write";
    idea?: string;
    engine?: "local" | "cloud";
    cloud?: { baseUrl: string; apiKey: string; model: string; apiFormat?: string };
    volumeCount?: number;
    chapterCount?: number;
    chapterId?: string;
    targetWords?: number;
};

export async function generateNovel(config: AiConfig, id: string, input: NovelGenerateInput) {
    return (await client(config).post<{ novel: NovelProject }>(
        `/api/novels/${encodeURIComponent(id)}/generate`,
        input,
        GENERATE_TIMEOUT,
    )).novel;
}
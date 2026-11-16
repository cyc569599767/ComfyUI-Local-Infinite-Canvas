import axios from "axios";
import { nanoid } from "nanoid";

import { attachLocalCancel, attachLocalProgress, localGatewayRoot } from "@/services/api/image";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import { withLocalProxy } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type FreeWorkflowSource = {
    id: string;
    name: string;
    folder: string;
    relative: string;
    format: "ui" | "api" | "invalid";
    updatedAt: string;
};

export type FreeWorkflowPreset = {
    size?: string;
    aspectRatio?: string;
    count?: number;
    seed?: string;
    seedFixed?: string;
};

export type FreeWorkflowTextInput = {
    node: string;
    input: string;
    label: string;
    default: string;
    role: string;
};

export type FreeWorkflowOutputType = "image" | "video" | "audio";

export type FreeWorkflowSummary = {
    id: string;
    name: string;
    sourceRel: string;
    sourceFormat: "ui" | "api";
    outputType: FreeWorkflowOutputType | null;
    archived: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
    sourceChanged: boolean;
    sourceMissing?: boolean;
    prompt: boolean;
    textInputs?: FreeWorkflowTextInput[];
    imageInputs: number;
    /** 参考音频输入数量（音色克隆类工作流为 1）。 */
    audioInputs?: number;
    size: { width: number; height: number } | null;
    aspectRatio?: string | null;
    aspectRatios?: string[];
    count: number | null;
    hasSeed: boolean;
    seed: string | null;
    preset?: FreeWorkflowPreset | null;
    customBindings?: FreeWorkflowCustomBinding[];
    warnings: string[];
};

/** 固定项出现在哪里：卡片上直接编辑，还是收进「生成设置」弹层。 */
export type FreeWorkflowBindingSurface = "card" | "settings";

/** 用户固定到卡片上的配置项（工作流里的某个节点的某个输入）。 */
export type FreeWorkflowCustomBinding = {
    node: string;
    input: string;
    label: string;
    /** 缺省（旧数据）按 card 处理。 */
    surface?: FreeWorkflowBindingSurface;
};

/** 简化节点图：只保留可绑定的输入，供画布内的可视化用。 */
export type FreeWorkflowGraphInput = {
    name: string;
    kind: "text" | "number" | "combo" | "boolean";
    value: string | number | boolean;
    options: string[];
    integer: boolean;
};

export type FreeWorkflowGraphNode = {
    id: string;
    title: string;
    classType: string;
    mode: number;
    output: boolean;
    inputs: FreeWorkflowGraphInput[];
};

export type FreeWorkflowGraph = {
    nodes: FreeWorkflowGraphNode[];
    links: Array<{ from: string; to: string; input: string }>;
};

export type FreeWorkflowRequest = {
    prompt: string;
    texts?: Array<{ node: string; input: string; value: string }>;
    /** 固定配置项的当前值；只对已登记的 customBindings 生效。 */
    values?: Array<{ node: string; input: string; value: string | number | boolean }>;
    size?: string;
    ratio?: string;
    count?: number;
    seed?: string;
    seedFixed?: boolean;
    images?: ReferenceImage[];
    /** 音频工作流的参考音频（音色克隆）。 */
    audio?: File;
    signal?: AbortSignal;
};

function gatewayRoot(config: AiConfig) {
    const root = localGatewayRoot(config.baseUrl);
    if (!root) throw new Error("自由卡片只支持本地网关");
    return root;
}

function readError(error: unknown, fallback: string) {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as { error?: { message?: string }; message?: string; msg?: string } | undefined;
        return data?.error?.message || data?.message || data?.msg || error.message || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

export async function fetchFreeWorkflowSources(config: AiConfig): Promise<FreeWorkflowSource[]> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ sources?: FreeWorkflowSource[] }>(`${root}/api/free-workflows/sources`, { timeout: 30000 });
    return Array.isArray(response.data?.sources) ? response.data.sources : [];
}

export async function fetchFreeWorkflows(config: AiConfig, archived = false): Promise<FreeWorkflowSummary[]> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ workflows?: FreeWorkflowSummary[] }>(`${root}/api/free-workflows${archived ? "?archived=1" : ""}`, { timeout: 30000 });
    return Array.isArray(response.data?.workflows) ? response.data.workflows : [];
}

export async function fetchFreeWorkflow(config: AiConfig, id: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { timeout: 30000 });
    if (!response.data?.workflow) throw new Error("自由卡片读取失败");
    return response.data.workflow;
}

export async function importFreeWorkflow(config: AiConfig, relative: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/import`, { path: relative }, { timeout: 120000 });
        if (!response.data?.workflow) throw new Error("自由卡片导入失败");
        return response.data.workflow;
    } catch (error) {
        throw new Error(readError(error, "自由卡片导入失败"));
    }
}

export async function syncFreeWorkflow(config: AiConfig, id: string): Promise<{ changed: boolean; workflow: FreeWorkflowSummary }> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ changed?: boolean; workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/sync`, {}, { timeout: 120000 });
        if (!response.data?.workflow) throw new Error("同步工作流失败");
        return { changed: Boolean(response.data.changed), workflow: response.data.workflow };
    } catch (error) {
        throw new Error(readError(error, "同步工作流失败"));
    }
}

export async function archiveFreeWorkflow(config: AiConfig, id: string, archived = true, preset?: FreeWorkflowPreset): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    const response = await axios.patch<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { archived, preset }, { timeout: 30000 });
    if (!response.data?.workflow) throw new Error("归档自由卡片失败");
    return response.data.workflow;
}

export async function deleteFreeWorkflow(config: AiConfig, id: string): Promise<void> {
    const root = gatewayRoot(config);
    try {
        await axios.delete(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { timeout: 30000 });
    } catch (error) {
        throw new Error(readError(error, "删除自由卡片失败"));
    }
}

export async function renameFreeWorkflow(config: AiConfig, id: string, name: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.patch<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { name }, { timeout: 30000 });
        if (!response.data?.workflow) throw new Error("重命名自由卡片失败");
        return response.data.workflow;
    } catch (error) {
        throw new Error(readError(error, "重命名自由卡片失败"));
    }
}

/** 读简化节点图 + 已固定的配置项。 */
export async function fetchFreeWorkflowGraph(config: AiConfig, id: string): Promise<{ graph: FreeWorkflowGraph; customBindings: FreeWorkflowCustomBinding[] }> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.get<{ graph?: FreeWorkflowGraph; customBindings?: FreeWorkflowCustomBinding[] }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/graph`, { timeout: 30000 });
        return {
            graph: { nodes: response.data?.graph?.nodes || [], links: response.data?.graph?.links || [] },
            customBindings: response.data?.customBindings || [],
        };
    } catch (error) {
        throw new Error(readError(error, "读取工作流节点图失败"));
    }
}

/** 保存固定的配置项。网关会丢弃不存在的节点/输入，返回的就是实际生效的列表。 */
export async function saveFreeWorkflowBindings(config: AiConfig, id: string, bindings: FreeWorkflowCustomBinding[]): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.patch<{ workflow?: FreeWorkflowSummary }>(
            `${root}/api/free-workflows/${encodeURIComponent(id)}/bindings`,
            { bindings: bindings.map((item) => ({ node: item.node, input: item.input, label: item.label, surface: item.surface === "settings" ? "settings" : "card" })) },
            { timeout: 30000 },
        );
        if (!response.data?.workflow) throw new Error("保存固定配置失败");
        return response.data.workflow;
    } catch (error) {
        throw new Error(readError(error, "保存固定配置失败"));
    }
}

export async function freeWorkflowComfyUrl(config: AiConfig, id: string): Promise<{ url: string; name: string; sourceRel: string; sourceFormat: "ui" | "api"; bridge: boolean; bridgeReason?: string }> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ url?: string; name?: string; sourceRel?: string; sourceFormat?: "ui" | "api"; bridge?: boolean; bridgeReason?: string }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/open`, { timeout: 15000 });
    if (!response.data?.url) throw new Error("无法获取 ComfyUI 地址");
    return {
        url: response.data.url,
        name: response.data.name || "",
        sourceRel: response.data.sourceRel || "",
        sourceFormat: response.data.sourceFormat || "ui",
        bridge: Boolean(response.data.bridge),
        bridgeReason: response.data.bridgeReason,
    };
}

async function buildFormData(config: AiConfig, request: FreeWorkflowRequest) {
    const formData = new FormData();
    formData.set("prompt", request.prompt);
    if (request.texts?.length) formData.set("texts", JSON.stringify(request.texts));
    if (request.values?.length) formData.set("values", JSON.stringify(request.values));
    if (request.size) formData.set("size", request.size);
    if (request.ratio) formData.set("ratio", request.ratio);
    if (request.count) formData.set("n", String(request.count));
    if (request.seed) formData.set("seed", request.seed);
    formData.set("seedFixed", request.seedFixed ? "true" : "false");
    formData.set("response_format", "b64_json");
    const images = request.images || [];
    const files = await Promise.all(images.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file, index) => formData.append(index === 0 ? "image" : `image${index + 1}`, file, file.name));
    // 音频工作流的参考音频（音色克隆）：网关按 audios 字段名收集。
    if (request.audio) formData.append("audios", request.audio, request.audio.name || "reference.wav");
    return formData;
}

export async function requestFreeWorkflowImage(config: AiConfig, id: string, request: FreeWorkflowRequest) {
    const root = gatewayRoot(config);
    const formData = await buildFormData(config, request);
    const requestId = `free_${nanoid()}`;
    const detachCancel = attachLocalCancel(config, requestId, request.signal);
    const detachProgress = attachLocalProgress(config, requestId, request.signal);
    try {
        const response = await axios.post<{ data?: Array<{ b64_json?: string; url?: string }> }>(`${root}/v1/free-workflows/${encodeURIComponent(id)}/images`, formData, {
            headers: { "X-Request-Id": requestId },
            signal: request.signal,
            timeout: 10 * 60 * 1000,
        });
        const items = response.data?.data || [];
        const images = items
            .map((item) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url || ""))
            .filter(Boolean)
            .map((dataUrl) => ({ id: nanoid(), dataUrl }));
        if (!images.length) throw new Error("自由工作流没有返回图片");
        return images;
    } catch (error) {
        throw new Error(readError(error, "自由工作流生成失败"));
    } finally {
        detachCancel?.();
        detachProgress?.();
    }
}

export async function requestFreeWorkflowAudio(config: AiConfig, id: string, request: FreeWorkflowRequest): Promise<{ blob: Blob; mimeType: string }> {
    const root = gatewayRoot(config);
    const formData = await buildFormData(config, request);
    const requestId = `free_${nanoid()}`;
    const detachCancel = attachLocalCancel(config, requestId, request.signal);
    const detachProgress = attachLocalProgress(config, requestId, request.signal);
    try {
        const response = await axios.post<{ data?: Array<{ b64_json?: string; url?: string }>; mime_type?: string }>(`${root}/v1/free-workflows/${encodeURIComponent(id)}/audio`, formData, {
            headers: { "X-Request-Id": requestId },
            signal: request.signal,
            timeout: 30 * 60 * 1000,
        });
        const item = response.data?.data?.[0];
        const mimeType = response.data?.mime_type || "audio/flac";
        if (!item) throw new Error("自由工作流没有返回音频");
        if (item.b64_json) {
            const binary = atob(item.b64_json);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return { blob: new Blob([bytes], { type: mimeType }), mimeType };
        }
        const fetched = await fetch(withLocalProxy(item.url || ""));
        const blob = await fetched.blob();
        return { blob: blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: mimeType }), mimeType };
    } catch (error) {
        throw new Error(readError(error, "自由工作流音频生成失败"));
    } finally {
        detachCancel?.();
        detachProgress?.();
    }
}

export async function createFreeWorkflowVideoTask(config: AiConfig, id: string, request: FreeWorkflowRequest) {
    const root = gatewayRoot(config);
    const formData = await buildFormData(config, request);
    try {
        const response = await axios.post<{ id?: string }>(`${root}/v1/free-workflows/${encodeURIComponent(id)}/videos`, formData, {
            signal: request.signal,
            timeout: 120000,
        });
        if (!response.data?.id) throw new Error("自由工作流没有返回视频任务");
        return response.data.id;
    } catch (error) {
        throw new Error(readError(error, "自由工作流视频任务创建失败"));
    }
}

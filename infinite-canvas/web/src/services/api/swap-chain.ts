import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";

export type SwapChainMode = "single_swap" | "double_swap" | "edit_clothes" | "edit_light" | "edit_time";
export type SwapChainTargetSelection = { x: number; y: number; width: number; height: number };

export type SwapChainJob = {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
    stage: string;
    progress: number;
    mode: SwapChainMode;
    intent: string;
    targetBoxes: SwapChainTargetSelection[];
    seed: number;
    promptIds: Array<{ stage: string; promptId: string }>;
    /** 源片真实尺寸（探测失败时为 null）。 */
    sourceSize?: { width: number; height: number } | null;
    /** 实际使用的画布短边（480–736，32 的倍数）。 */
    shortEdge?: number | null;
    sourceFrameCount?: number | null;
    frames?: number | null;
    /** 是否走「只换脸、保留服装」路径。 */
    keepClothes?: boolean;
    /** 想保留服装但不支持该模式时的回退说明。 */
    keepClothesSkipped?: string | null;
    gates: Record<string, unknown>;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    artifacts: { video: string; painted: string; target: string; contact: string };
};

type CreateInput = {
    source: File;
    refs: File[];
    intent: string;
    mode: SwapChainMode;
    targetSelection?: SwapChainTargetSelection | null;
    seed?: number;
    /** 是否保留原片服装：true=只换脸，服装/身体/背景沿用原片。 */
    keepClothes?: boolean;
    signal?: AbortSignal;
};

function gatewayBase() {
    return (LOCAL_GATEWAY_ORIGIN || window.location.origin).replace(/\/+$/, "");
}

async function readError(response: Response) {
    const text = await response.text().catch(() => "");
    try {
        const data = JSON.parse(text);
        return data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    } catch {
        return text || `HTTP ${response.status}`;
    }
}

export async function createSwapChainTask(input: CreateInput): Promise<SwapChainJob> {
    const form = new FormData();
    form.append("source_video", input.source, input.source.name);
    input.refs.forEach((file) => form.append("refs", file, file.name));
    form.append("intent", input.intent);
    form.append("mode", input.mode);
    if (input.targetSelection) form.append("target_selection", JSON.stringify(input.targetSelection));
    if (input.seed) form.append("seed", String(input.seed));
    if (input.keepClothes) form.append("keep_clothes", "true");
    const response = await fetch(`${gatewayBase()}/v1/swap-chain`, { method: "POST", body: form, signal: input.signal });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as SwapChainJob;
}

export async function fetchSwapChainJob(id: string, signal?: AbortSignal): Promise<SwapChainJob> {
    const response = await fetch(`${gatewayBase()}/v1/swap-chain/${encodeURIComponent(id)}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as SwapChainJob;
}

export async function cancelSwapChainJob(id: string): Promise<SwapChainJob> {
    const response = await fetch(`${gatewayBase()}/v1/swap-chain/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as SwapChainJob;
}

export async function resumeSwapChainJob(id: string): Promise<SwapChainJob> {
    const response = await fetch(`${gatewayBase()}/v1/swap-chain/${encodeURIComponent(id)}/resume`, { method: "POST" });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as SwapChainJob;
}

export function swapChainArtifactUrl(pathname: string | undefined) {
    return pathname ? `${gatewayBase()}${pathname}` : "";
}

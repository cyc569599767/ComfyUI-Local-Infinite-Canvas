// 角色替换长链（swap-chain）的客户端流程。
//
// 网关侧是任务制：POST /v1/swap-chain 返回 job，之后轮询 /v1/swap-chain/:id。
// 链路分 7 段（意图解析 → 取帧 → 图像换人 → 图像门 → 视频 → 视频门 → 交付），
// 中间会自动重试，所以要给足时间；失败时网关会带上是哪一段挂的。
//
// 用 Qwen 2.1 + oldx 人物替换 LoRA 做逐帧换人，再用 H3 出片。
import { cancelSwapChainJob, createSwapChainTask, fetchSwapChainJob, swapChainArtifactUrl, type SwapChainJob, type SwapChainMode, type SwapChainTargetSelection } from "@/services/api/swap-chain";

export type SwapChainResult = {
    jobId: string;
    videoUrl: string;
    /** 换人后的静帧，用于在画布上先给个视觉反馈。 */
    paintedUrl: string;
    mode: SwapChainMode;
    /** 实际是否走了「只换脸、保留服装」路径。 */
    keepClothes: boolean;
    /** 勾了保留服装但当前模式不支持时的回退说明。 */
    keepClothesSkipped: string | null;
};

export class SwapChainCancelledError extends Error {
    constructor() {
        super("已取消");
        this.name = "SwapChainCancelledError";
    }
}

export class SwapChainFailedError extends Error {
    readonly jobId: string | null;
    readonly stage: string | null;
    constructor(message: string, jobId: string | null, stage: string | null) {
        super(message);
        this.name = "SwapChainFailedError";
        this.jobId = jobId;
        this.stage = stage;
    }
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
// 整条链含两次生成 + 自动重试，单段就能跑到 15–20 分钟，给 40 分钟兜底。
const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;

function abortError() {
    return new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** 把 job 的阶段翻成给用户看的中文短语。 */
export function describeSwapChainStage(stage: string | undefined | null): string {
    const key = String(stage || "");
    if (key.startsWith("s1")) return "解析意图";
    if (key.startsWith("s2")) return "抽取关键帧";
    if (key.startsWith("s3")) return "逐帧换人";
    if (key.startsWith("s4")) return "校验换人结果";
    if (key.startsWith("s5")) return "生成视频";
    if (key.startsWith("s6")) return "校验视频";
    if (key.startsWith("s7")) return "交付成片";
    return "处理中";
}

/**
 * 提交换人任务并轮询到终态。
 *
 * - signal 中断时调用网关取消接口，并抛 AbortError。
 * - 失败/取消/超时都抛错，绝不静默返回空结果。
 * - 网关报 failed 时把 stage 一起带出来，方便用户判断是换人还是出片失败。
 */
export async function requestSwapChain(
    input: {
        source: File;
        refs: File[];
        intent: string;
        mode: SwapChainMode;
        targetSelection?: SwapChainTargetSelection | null;
        /** 是否保留原片服装：true=只换脸，服装/身体/背景沿用原片。 */
        keepClothes?: boolean;
        seed?: number;
    },
    options: {
        signal?: AbortSignal;
        pollIntervalMs?: number;
        timeoutMs?: number;
        onProgress?: (job: SwapChainJob, label: string) => void;
    } = {},
): Promise<SwapChainResult> {
    const { signal, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress } = options;
    if (signal?.aborted) throw abortError();

    const created = await createSwapChainTask({ ...input, signal });
    const jobId = created.id;
    if (!jobId) throw new SwapChainFailedError("换人服务没有返回任务号", null, null);

    const deadline = Date.now() + timeoutMs;
    try {
        for (;;) {
            if (signal?.aborted) throw abortError();
            if (Date.now() > deadline) {
                throw new SwapChainFailedError(`角色替换超时（${Math.round(timeoutMs / 60000)} 分钟），可稍后重试`, jobId, created.stage || null);
            }

            let job: SwapChainJob;
            try {
                job = await fetchSwapChainJob(jobId, signal);
            } catch (error) {
                if (isAbortError(error)) throw error;
                // 轮询偶发失败不算终态，继续等，由 deadline 兜底。
                await sleep(pollIntervalMs, signal);
                continue;
            }

            onProgress?.(job, describeSwapChainStage(job.stage));

            if (job.status === "completed") {
                const videoUrl = swapChainArtifactUrl(job.artifacts?.video);
                if (!videoUrl) throw new SwapChainFailedError("换人任务已完成但没有返回成片地址", jobId, job.stage);
                return {
                    jobId,
                    videoUrl,
                    paintedUrl: swapChainArtifactUrl(job.artifacts?.painted),
                    mode: job.mode,
                    keepClothes: Boolean(job.keepClothes),
                    keepClothesSkipped: job.keepClothesSkipped || null,
                };
            }
            if (job.status === "failed") throw new SwapChainFailedError(job.error || "角色替换失败", jobId, job.stage || null);
            if (job.status === "cancelled") throw new SwapChainCancelledError();
            if (job.status === "interrupted") throw new SwapChainFailedError("换人任务被中断，可重试或继续", jobId, job.stage || null);

            await sleep(pollIntervalMs, signal);
        }
    } catch (error) {
        // 任何中断都要真的把网关任务停掉，否则 GPU 继续白跑。
        if (isAbortError(error) || error instanceof SwapChainFailedError) {
            await cancelSwapChainJob(jobId).catch(() => undefined);
        }
        throw error;
    }
}

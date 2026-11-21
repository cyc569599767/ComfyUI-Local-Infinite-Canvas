// 「3D 场景」全景生成的客户端流程。
//
// 网关侧是任务制：POST /v1/images/scene3d 返回 taskId，之后轮询 /v1/tasks/:id，
// 完成时 task.url 指向 5664×2832 的全景 PNG（等距柱状，用于 TE 导演台全景背景，
// 不是可走入的 3D mesh）。
//
// 这里把「提交 + 轮询到终态」收敛成一个可测试的函数，UI 只负责拿结果写画布。
import { cancelScene3DTask, createScene3DJob, getScene3DTask, type Scene3DOffset, type Scene3DTaskState } from "@/services/api/scene3d";

export type { Scene3DOffset };

export type Scene3DPanoramaResult = {
    url: string;
    bytes: number;
};

export class Scene3DCancelledError extends Error {
    constructor() {
        super("已取消");
        this.name = "Scene3DCancelledError";
    }
}

export class Scene3DFailedError extends Error {
    readonly taskId: string | null;
    constructor(message: string, taskId: string | null) {
        super(message);
        this.name = "Scene3DFailedError";
        this.taskId = taskId;
    }
}

const DEFAULT_POLL_INTERVAL_MS = 1200;
// 全景要跑两段工作流（H3-Image 扩图 + Qwen 修缝），还有最多 3 个种子的重试。
// 给足 20 分钟，超时明确报错而不是无限等待。
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function abortError() {
    return new DOMException("Aborted", "AbortError");
}

/**
 * 提交全景任务并轮询到终态。
 *
 * - 提交接口若直接返回 panoramaUrl（同步模式），立即返回，不进轮询。
 * - signal 中断时调用网关取消接口，并抛 AbortError，让上层按「用户取消」处理。
 * - 失败/取消/超时都抛错，绝不静默返回空结果。
 */
export async function requestScene3DPanorama(
    image: File,
    prompt: string,
    options: {
        offset?: Scene3DOffset;
        signal?: AbortSignal;
        pollIntervalMs?: number;
        timeoutMs?: number;
        onProgress?: (state: Scene3DTaskState) => void;
    } = {},
): Promise<Scene3DPanoramaResult> {
    const { offset, signal, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress } = options;
    if (signal?.aborted) throw abortError();

    const created = await createScene3DJob(image, prompt, offset, signal);

    // 同步返回模式：网关直接把全景给出来了。
    if (created.panoramaUrl) return { url: created.panoramaUrl, bytes: 0 };

    const taskId = created.taskId;
    if (!taskId) throw new Scene3DFailedError("3D 场景服务没有返回任务号", null);

    const deadline = Date.now() + timeoutMs;
    try {
        for (;;) {
            if (signal?.aborted) throw abortError();
            if (Date.now() > deadline) {
                throw new Scene3DFailedError(`3D 场景生成超时（${Math.round(timeoutMs / 60000)} 分钟），可稍后重试`, taskId);
            }

            let state: Scene3DTaskState;
            try {
                state = await getScene3DTask(taskId, signal);
            } catch (error) {
                // 取消要走外层 catch 去发 cancel，不能在这里吞掉。
                if (isAbortError(error)) throw error;
                // 轮询偶发失败（网关重启/网络抖动）不算终态，继续等，由 deadline 兜底。
                await sleep(pollIntervalMs, signal);
                continue;
            }

            onProgress?.(state);

            if (state.status === "completed") {
                if (!state.url) throw new Scene3DFailedError("3D 场景任务已完成但没有返回图片地址", taskId);
                return { url: state.url, bytes: state.bytes || 0 };
            }
            if (state.status === "failed") throw new Scene3DFailedError(state.error || "3D 场景生成失败", taskId);
            if (state.status === "cancelled") throw new Scene3DCancelledError();

            await sleep(pollIntervalMs, signal);
        }
    } catch (error) {
        // 任何中断（用户取消 / 超时）都要真的把网关任务停掉，否则 GPU 会继续白跑。
        // 注意 sleep() 内部抛出的 AbortError 也会走到这里 —— 之前只在循环开头检查
        // signal，导致「等待期间取消」完全没发 cancel 请求。
        if (isAbortError(error) || error instanceof Scene3DFailedError) {
            await cancelScene3DTask(taskId).catch(() => undefined);
        }
        throw error;
    }
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

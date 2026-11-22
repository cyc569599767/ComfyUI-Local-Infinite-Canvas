// 角色替换长链（swap-chain）的任务流。
//
// 这条链用 Qwen 2.1 + oldx 人物替换 LoRA 逐帧换人，再用 H3 出片，
// 中间有 7 段、会自动重试。这里用真实 HTTP server 收包，验证：
//   1. 正常路径：提交后轮询到 completed，拿到成片与静帧地址
//   2. 阶段名翻成中文，供 UI 显示「正在逐帧换人」这类提示
//   3. 失败把 stage 带出来（判断是换人挂还是出片挂）
//   4. cancelled / interrupted 分别是不同错误类型
//   5. 轮询抖动不当终态
//   6. 用户取消必发 cancel（曾踩过：sleep 内部抛 AbortError 会跳过 cancel）
//   7. 超时主动取消
import { afterAll, expect, test } from "bun:test";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});

let script: (path: string, call: number) => Response | Promise<Response> = () => Response.json({});
let calls: { path: string; method: string }[] = [];
let counters = new Map<string, number>();

const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
        const path = new URL(req.url).pathname;
        calls.push({ path, method: req.method });
        const n = (counters.get(path) || 0) + 1;
        counters.set(path, n);
        return script(path, n);
    },
});

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://127.0.0.1");
    if (/\/v1\/swap-chain/.test(url.pathname)) {
        return realFetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
    }
    return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const { requestSwapChain, describeSwapChainStage, SwapChainCancelledError, SwapChainFailedError } = await import("../src/services/api/swap-chain-job");

function reset(next: typeof script) {
    script = next;
    calls = [];
    counters = new Map();
}

const video = () => new File([new Uint8Array([1, 2, 3])], "source.mp4", { type: "video/mp4" });
const images = (n: number) => Array.from({ length: n }, (_, i) => new File([new Uint8Array([i])], `ref${i}.png`, { type: "image/png" }));
const input = () => ({ source: video(), refs: images(1), intent: "把男主换成图中人物", mode: "single_swap" as const });

const job = (over: Record<string, unknown> = {}) => ({
    id: "sc1",
    status: "running",
    stage: "s3_image",
    progress: 20,
    mode: "single_swap",
    intent: "x",
    targetBoxes: [],
    seed: 1,
    promptIds: [],
    gates: {},
    error: null,
    createdAt: "",
    updatedAt: "",
    artifacts: { video: "/v1/swap-chain/sc1/content/video", painted: "/v1/swap-chain/sc1/content/painted", target: "", contact: "" },
    ...over,
});

afterAll(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
});

test("阶段名翻成中文，覆盖全部 7 段", () => {
    expect(describeSwapChainStage("s1_intent")).toBe("解析意图");
    expect(describeSwapChainStage("s2_frame")).toBe("抽取关键帧");
    expect(describeSwapChainStage("s3_image_2")).toBe("逐帧换人");
    expect(describeSwapChainStage("s4_image_gate")).toBe("校验换人结果");
    expect(describeSwapChainStage("s5_video_1")).toBe("生成视频");
    expect(describeSwapChainStage("s6_video_gate")).toBe("校验视频");
    expect(describeSwapChainStage("s7_delivery")).toBe("交付成片");
    // 未知/空阶段不能显示 undefined
    expect(describeSwapChainStage(undefined)).toBe("处理中");
    expect(describeSwapChainStage("weird")).toBe("处理中");
});

test("正常路径：提交后轮询到 completed，拿到成片与静帧地址", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued", stage: "s1_intent", progress: 0 }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "completed", stage: "s7_delivery", progress: 100 }));
        return Response.json({});
    });
    const result = await requestSwapChain(input(), { pollIntervalMs: 5 });
    expect(result.jobId).toBe("sc1");
    expect(result.videoUrl).toContain("/v1/swap-chain/sc1/content/video");
    expect(result.paintedUrl).toContain("/v1/swap-chain/sc1/content/painted");
    expect(result.mode).toBe("single_swap");
    expect(calls.some((c) => c.path === "/v1/swap-chain" && c.method === "POST")).toBe(true);
});

test("完成但成片地址为空时报错，不返回空结果", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "completed", stage: "s7_delivery", artifacts: { video: "", painted: "", target: "", contact: "" } }));
        return Response.json({});
    });
    const error = await requestSwapChain(input(), { pollIntervalMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(SwapChainFailedError);
    expect(String(error.message)).toMatch(/没有返回成片地址/);
});

test("失败时把 stage 带出来，能区分换人挂还是出片挂", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "failed", stage: "s3_image_3", error: "换人结果未过身份校验" }));
        return Response.json({});
    });
    const error = await requestSwapChain(input(), { pollIntervalMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(SwapChainFailedError);
    expect(error.stage).toBe("s3_image_3");
    expect(error.jobId).toBe("sc1");
    expect(String(error.message)).toMatch(/身份校验/);
});

test("cancelled 抛 SwapChainCancelledError", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "cancelled" }));
        return Response.json({});
    });
    const error = await requestSwapChain(input(), { pollIntervalMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(SwapChainCancelledError);
});

test("interrupted 抛 SwapChainFailedError 并提示可继续", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "interrupted", stage: "s5_video" }));
        return Response.json({});
    });
    const error = await requestSwapChain(input(), { pollIntervalMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(SwapChainFailedError);
    expect(String(error.message)).toMatch(/中断/);
});

test("轮询抖动（502）不当终态，继续等到成功", async () => {
    reset((path, n) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path === "/v1/swap-chain/sc1") {
            if (n === 1) return new Response("bad gateway", { status: 502 });
            if (n === 2) return Response.json(job({ status: "running", stage: "s5_video", progress: 45 }));
            return Response.json(job({ status: "completed", stage: "s7_delivery", progress: 100 }));
        }
        return Response.json({});
    });
    const result = await requestSwapChain(input(), { pollIntervalMs: 5 });
    expect(result.videoUrl).toContain("/content/video");
    expect(calls.filter((c) => c.path === "/v1/swap-chain/sc1").length).toBe(3);
});

test("用户取消必发 cancel 请求（sleep 内部中断也要发）", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path.endsWith("/cancel")) return Response.json(job({ status: "cancelled" }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "running", stage: "s3_image", progress: 20 }));
        return Response.json({});
    });
    const controller = new AbortController();
    const pending = requestSwapChain(input(), { pollIntervalMs: 10, signal: controller.signal });
    await Bun.sleep(30);
    controller.abort();
    const error = await pending.catch((e) => e);
    expect(error instanceof DOMException && error.name === "AbortError").toBe(true);
    expect(calls.some((c) => c.path.includes("/v1/swap-chain/sc1/cancel"))).toBe(true);
});

test("超时主动取消，不无限等待", async () => {
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path.endsWith("/cancel")) return Response.json(job({ status: "cancelled" }));
        if (path === "/v1/swap-chain/sc1") return Response.json(job({ status: "running", stage: "s3_image", progress: 20 }));
        return Response.json({});
    });
    const error = await requestSwapChain(input(), { pollIntervalMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(error).toBeInstanceOf(SwapChainFailedError);
    expect(String(error.message)).toMatch(/超时/);
    expect(calls.some((c) => c.path.includes("/v1/swap-chain/sc1/cancel"))).toBe(true);
});

test("提交阶段就取消：不发起轮询", async () => {
    reset(() => Response.json(job({ status: "queued" })));
    const controller = new AbortController();
    controller.abort();
    const error = await requestSwapChain(input(), { pollIntervalMs: 5, signal: controller.signal }).catch((e) => e);
    expect(error instanceof DOMException && error.name === "AbortError").toBe(true);
    expect(calls.length).toBe(0);
});

test("onProgress 能收到阶段中文名与进度", async () => {
    const seen: string[] = [];
    reset((path) => {
        if (path === "/v1/swap-chain") return Response.json(job({ status: "queued" }));
        if (path === "/v1/swap-chain/sc1") {
            const n = counters.get(path) || 1;
            if (n === 1) return Response.json(job({ status: "running", stage: "s3_image", progress: 20 }));
            return Response.json(job({ status: "completed", stage: "s7_delivery", progress: 100 }));
        }
        return Response.json({});
    });
    await requestSwapChain(input(), { pollIntervalMs: 5, onProgress: (_job, label) => seen.push(label) });
    expect(seen).toEqual(["逐帧换人", "交付成片"]);
});
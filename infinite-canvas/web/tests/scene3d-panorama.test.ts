// 「3D 场景」全景生成的任务流。
//
// 网关是任务制：提交拿 taskId → 轮询 /v1/tasks/:id → 完成时 task.url 指向
// 5664×2832 的全景 PNG。这里用真实 HTTP server 收包，验证：
//   1. 正常路径：提交后轮询到 completed，拿到 url 与字节数
//   2. 同步模式：提交直接返回 panoramaUrl 时不进轮询
//   3. 失败/取消任务会抛错，不会静默返回空结果
//   4. 轮询中途网关抖动（5xx/断连）不当终态，继续等到成功
//   5. 用户取消时调用网关取消接口并抛 AbortError
//   6. 超时会主动取消任务，不无限等待
import { afterAll, expect, test } from "bun:test";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});

/** 每个用例可改写的响应脚本。 */
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

// scene3d 客户端读的是 LOCAL_GATEWAY_BASE_URL（构建期常量），
// 所以把请求打到固定地址的 fetch 换成本地 server。
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://127.0.0.1");
    if (/\/v1\/(images\/scene3d|tasks\/)/.test(url.pathname)) {
        return realFetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
    }
    return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const { requestScene3DPanorama, Scene3DCancelledError, Scene3DFailedError } = await import("../src/services/api/scene3d-panorama");

function reset(next: typeof script) {
    script = next;
    calls = [];
    counters = new Map();
}

const image = () => new File([new Uint8Array([1, 2, 3])], "scene.png", { type: "image/png" });

afterAll(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
});

test("正常路径：提交后轮询到 completed 并返回全景地址", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t1", status: "queued" });
        if (path.endsWith("/v1/tasks/t1")) return Response.json({ id: "t1", status: "completed", progress: 1, url: "http://127.0.0.1:8190/files/pano.png", bytes: 12345 });
        return Response.json({});
    });
    const result = await requestScene3DPanorama(image(), "森林里的石台", { pollIntervalMs: 5 });
    expect(result.url).toBe("http://127.0.0.1:8190/files/pano.png");
    expect(result.bytes).toBe(12345);
    expect(calls.some((c) => c.path === "/v1/images/scene3d" && c.method === "POST")).toBe(true);
    expect(calls.filter((c) => c.path === "/v1/tasks/t1").length).toBe(1);
});

test("同步模式：提交直接返回 panoramaUrl 时不进轮询", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ panorama: { url: "http://x/pano.png", width: 5664, height: 2832 } });
        return Response.json({});
    });
    const result = await requestScene3DPanorama(image(), "", { pollIntervalMs: 5 });
    expect(result.url).toBe("http://x/pano.png");
    expect(calls.filter((c) => c.path.startsWith("/v1/tasks/")).length).toBe(0);
});

test("任务失败时抛错并带上网关给的原因", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t2", status: "queued" });
        if (path.endsWith("/v1/tasks/t2")) return Response.json({ id: "t2", status: "failed", progress: 0.4, error: "3D 场景质量门未通过（3 个种子）" });
        return Response.json({});
    });
    await expect(requestScene3DPanorama(image(), "x", { pollIntervalMs: 5 })).rejects.toThrow(/质量门未通过/);
});

test("任务被取消时抛 Scene3DCancelledError", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t3", status: "queued" });
        if (path.endsWith("/v1/tasks/t3")) return Response.json({ id: "t3", status: "cancelled" });
        return Response.json({});
    });
    const error = await requestScene3DPanorama(image(), "x", { pollIntervalMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(Scene3DCancelledError);
});

test("完成但没有 url 时明确报错，不返回空结果", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t4", status: "queued" });
        if (path.endsWith("/v1/tasks/t4")) return Response.json({ id: "t4", status: "completed", progress: 1, url: null });
        return Response.json({});
    });
    const error = await requestScene3DPanorama(image(), "x", { pollIntervalMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(Scene3DFailedError);
    expect(String(error.message)).toMatch(/没有返回图片地址/);
});

test("轮询中途网关抖动（5xx）不当终态，继续等到成功", async () => {
    reset((path, n) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t5", status: "queued" });
        if (path.endsWith("/v1/tasks/t5")) {
            if (n === 1) return new Response("bad gateway", { status: 502 });
            if (n === 2) return Response.json({ id: "t5", status: "running", progress: 0.5 });
            return Response.json({ id: "t5", status: "completed", progress: 1, url: "http://x/pano5.png", bytes: 9 });
        }
        return Response.json({});
    });
    const result = await requestScene3DPanorama(image(), "x", { pollIntervalMs: 5 });
    expect(result.url).toBe("http://x/pano5.png");
    // 3 次轮询：502 → running → completed
    expect(calls.filter((c) => c.path === "/v1/tasks/t5").length).toBe(3);
});

test("用户取消时调用网关取消接口并抛 AbortError", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t6", status: "queued" });
        if (path.includes("/cancel")) return Response.json({ ok: true });
        if (path.endsWith("/v1/tasks/t6")) return Response.json({ id: "t6", status: "running", progress: 0.3 });
        return Response.json({});
    });
    const controller = new AbortController();
    const pending = requestScene3DPanorama(image(), "x", { pollIntervalMs: 10, signal: controller.signal });
    await Bun.sleep(30);
    controller.abort();
    const error = await pending.catch((e) => e);
    expect(error instanceof DOMException && error.name === "AbortError").toBe(true);
    expect(calls.some((c) => c.path.includes("/v1/tasks/t6/cancel"))).toBe(true);
});

test("超时会主动取消任务，不无限等待", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t7", status: "queued" });
        if (path.includes("/cancel")) return Response.json({ ok: true });
        if (path.endsWith("/v1/tasks/t7")) return Response.json({ id: "t7", status: "running", progress: 0.2 });
        return Response.json({});
    });
    const error = await requestScene3DPanorama(image(), "x", { pollIntervalMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(error).toBeInstanceOf(Scene3DFailedError);
    expect(String(error.message)).toMatch(/超时/);
    expect(calls.some((c) => c.path.includes("/v1/tasks/t7/cancel"))).toBe(true);
});

test("提交阶段就取消：不发起轮询", async () => {
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t8", status: "queued" });
        return Response.json({ id: "t8", status: "running" });
    });
    const controller = new AbortController();
    controller.abort();
    const error = await requestScene3DPanorama(image(), "x", { pollIntervalMs: 5, signal: controller.signal }).catch((e) => e);
    expect(error instanceof DOMException && error.name === "AbortError").toBe(true);
    expect(calls.length).toBe(0);
});

test("onProgress 会收到中间进度，供 UI 显示", async () => {
    const seen: number[] = [];
    reset((path) => {
        if (path.endsWith("/v1/images/scene3d")) return Response.json({ id: "t9", status: "queued" });
        if (path.endsWith("/v1/tasks/t9")) {
            const n = counters.get(path) || 1;
            if (n === 1) return Response.json({ id: "t9", status: "running", progress: 0.4 });
            return Response.json({ id: "t9", status: "completed", progress: 1, url: "http://x/p9.png", bytes: 1 });
        }
        return Response.json({});
    });
    await requestScene3DPanorama(image(), "x", { pollIntervalMs: 5, onProgress: (state) => seen.push(state.progress) });
    expect(seen).toEqual([0.4, 1]);
});

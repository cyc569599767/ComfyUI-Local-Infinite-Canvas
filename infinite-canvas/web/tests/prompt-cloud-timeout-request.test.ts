import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import axios, { type InternalAxiosRequestConfig } from "axios";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { requestPromptOptimize, requestImagePromptOptimize, requestImageCaption } = await import("../src/services/api/image");
const cloud = { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", model: "fixture" };
const config = { ...defaultConfig, channels: [], baseUrl: "http://127.0.0.1:8190/v1", apiKey: "local", model: "video-h3-t2v", videoModel: "video-h3-t2v" };
const image = { id: "fixture", name: "fixture.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" };
let priorAdapter: typeof axios.defaults.adapter;
let requests: InternalAxiosRequestConfig[];
beforeEach(() => {
    priorAdapter = axios.defaults.adapter;
    requests = [];
    axios.defaults.adapter = async request => {
        requests.push(request);
        return { data: { prompt: "fixture prompt", engine: "cloud", mode: "文生视频(T2VA)", duration: 5 }, status: 200, statusText: "OK", headers: {}, config: request };
    };
});
afterEach(() => { axios.defaults.adapter = priorAdapter; });
afterAll(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("KVMem browser wait includes the advertised startup budget plus requested inference and cleanup allowance", async () => {
    await requestImageCaption({ ...config, promptLocalTimeoutSeconds: 1800 }, { images: [image], engine: "kvmem", startupTimeoutMs: 180000, timeoutMs: 840000 });
    expect((requests[0].data as FormData).get("localTimeoutSeconds")).toBe("1800");
    expect(requests[0].timeout).toBe(2040000);
});

const operations = [
    { name: "H3", call: (cfg: typeof config, engine: "local" | "cloud", seconds?: number, signal?: AbortSignal) => requestPromptOptimize(cfg, { prompt: "fixture", mode: "文生视频(T2VA)", engine, cloud: { ...cloud, timeoutSeconds: seconds } }, { signal }) },
    { name: "image optimize", call: (cfg: typeof config, engine: "local" | "cloud", seconds?: number, signal?: AbortSignal) => requestImagePromptOptimize(cfg, { prompt: "fixture", engine, cloud: { ...cloud, timeoutSeconds: seconds } }, { signal }) },
    { name: "caption", call: (cfg: typeof config, engine: "local" | "cloud", seconds?: number, signal?: AbortSignal) => requestImageCaption(cfg, { images: [image], engine: engine === "local" ? "kvmem" : "cloud", timeoutMs: 390000, cloud: { ...cloud, timeoutSeconds: seconds } }, { signal }) },
];
for (const operation of operations) {
    test(`${operation.name} cloud defaults to 600 seconds with browser delivery headroom`, async () => {
        await operation.call(config, "cloud");
        expect((requests[0].data as FormData).get("cloudTimeoutSeconds")).toBe("600");
        expect(requests[0].timeout).toBe(630000);
    });
    test(`${operation.name} forwards the selected profile timeout and honors an explicit override`, async () => {
        const cfg = { ...config, promptCloudTimeoutSeconds: 1200 };
        await operation.call(cfg, "cloud");
        expect((requests[0].data as FormData).get("cloudTimeoutSeconds")).toBe("1200");
        expect(requests[0].timeout).toBe(1230000);
        const signal = new AbortController().signal;
        await operation.call(cfg, "cloud", 1800, signal);
        expect((requests[1].data as FormData).get("cloudTimeoutSeconds")).toBe("1800");
        expect(requests[1].timeout).toBe(1830000);
        expect(requests[1].signal).toBe(signal);
    });
    test(`${operation.name} local timeout follows the local preference without sending a cloud override`, async () => {
        await operation.call({ ...config, promptCloudTimeoutSeconds: 30, promptLocalTimeoutSeconds: 1200 }, "local");
        expect((requests[0].data as FormData).get("localTimeoutSeconds")).toBe("1200");
        expect((requests[0].data as FormData).has("cloudTimeoutSeconds")).toBe(false);
        expect(requests[0].timeout).toBe(operation.name === "caption" ? 1860000 : 1230000);
    });
    test(`${operation.name} local timeout is not affected by cloud profile settings`, async () => {
        await operation.call({ ...config, promptCloudTimeoutSeconds: 1800 }, "local");
        expect((requests[0].data as FormData).has("cloudTimeoutSeconds")).toBe(false);
        expect((requests[0].data as FormData).get("localTimeoutSeconds")).toBe("600");
        expect(requests[0].timeout).toBe(operation.name === "caption" ? 1260000 : 630000);
    });
}

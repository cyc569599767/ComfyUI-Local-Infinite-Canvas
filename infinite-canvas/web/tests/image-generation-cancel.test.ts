import { afterAll, expect, test } from "bun:test";
import axios, { CanceledError } from "axios";
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { requestGeneration } = await import("../src/services/api/image");
afterAll(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("image controller stops all its batch HTTP requests with their own IDs, not another child", async () => {
    const adapter = axios.defaults.adapter;
    const fetch = globalThis.fetch;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 1, clearTimeout() {} } });
    const canceled: string[] = [];
    const pending: Array<{ request: any; resolve: (data: any) => void }> = [];
    globalThis.fetch = (async (url, options) => {
        expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:8190\/api\/requests\/img_[^/]+\/cancel$/);
        expect(options?.method).toBe("POST");
        canceled.push(String(url).split("/").at(-2)!);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    axios.defaults.adapter = async (request) => {
        if (request.method === "get") return { data: {}, status: 200, statusText: "OK", headers: {}, config: request };
        return new Promise((resolve, reject) => {
            pending.push({ request, resolve: (data) => resolve({ data, status: 200, statusText: "OK", headers: {}, config: request }) });
            request.signal?.addEventListener?.("abort", () => reject(new CanceledError("cancelled")), { once: true });
        });
    };
    try {
        const config = { ...defaultConfig, channels: [], baseUrl: "http://127.0.0.1:8190/v1", apiKey: "local", model: "image-fixture", imageModel: "image-fixture", size: "1024x1024", count: "1" };
        const first = new AbortController(), sibling = new AbortController();
        const tasks = [requestGeneration(config, "batch 1", { signal: first.signal }), requestGeneration(config, "batch 2", { signal: first.signal }), requestGeneration(config, "sibling", { signal: sibling.signal })];
        const settled = Promise.allSettled(tasks);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(pending).toHaveLength(3);
        const requestId = (index: number) => String(pending[index].request.headers.get("X-Request-Id"));
        first.abort("user-stop");
        expect(canceled.sort()).toEqual([requestId(0), requestId(1)].sort());
        expect(pending[2].request.signal.aborted).toBe(false);
        pending[2].resolve({ data: [{ b64_json: "c3libGluZw==" }] });
        const results = await settled;
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
        sibling.abort("user-stop");
        expect(canceled).toHaveLength(2); // Finished requests detach their cancel handlers.
    } finally {
        axios.defaults.adapter = adapter;
        globalThis.fetch = fetch;
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});

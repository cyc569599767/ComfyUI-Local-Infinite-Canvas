import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import axios, { AxiosError, CanceledError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const realSetTimeout = globalThis.setTimeout;
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
});
const { defaultConfig } = await import("../src/stores/use-config-store");
const mediaStorage = await import("../src/services/file-storage");
const { pollVideoGenerationTask, storeGeneratedVideo, waitForVideoGenerationTask } = await import("../src/services/api/video");

const config = { ...defaultConfig, channels: [], baseUrl: "https://video-api.fixture.invalid/v1", apiKey: "fixture-only", model: "test-video", videoModel: "test-video" };
const task = { id: "existing-task", provider: "openai" as const, model: "test-video" };
const resultUrl = "https://video-result.fixture.invalid/final.mp4";
const videoBlob = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])], { type: "video/mp4" });
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
let originalAdapter: typeof axios.defaults.adapter;
let requests: InternalAxiosRequestConfig[];
let adapter: AxiosAdapter;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let timerSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;

function response(request: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse {
    return { data, status, statusText: String(status), headers: {}, config: request };
}
function httpError(request: InternalAxiosRequestConfig, status: number) {
    return new AxiosError("fixture HTTP failure", status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST", request, undefined, response(request, {}, status));
}
function transientError(request: InternalAxiosRequestConfig, code: string) {
    return new AxiosError("fixture timeout/network failure", code, request);
}
function statusResponse(request: InternalAxiosRequestConfig, status: string, url?: string) {
    expect(request.timeout).toBe(15_000);
    return response(request, { id: task.id, status, ...(url ? { url } : {}) });
}
function expectOnlyGets(count: number) {
    expect(requests).toHaveLength(count);
    expect(requests.every((request) => request.method === "get")).toBe(true);
}

beforeEach(() => {
    originalAdapter = axios.defaults.adapter;
    requests = [];
    adapter = async () => { throw new Error("Unexpected mock request"); };
    // A custom axios adapter provides deterministic transport failures without any API traffic.
    axios.defaults.adapter = async (request) => {
        requests.push(request);
        return adapter(request);
    };
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected fetch: no network is permitted"); });
    // Only accelerate retry backoff. Transport timeouts are asserted and rejected by the adapter.
    timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback, ms, ...args) => realSetTimeout(callback, ms === 500 || ms === 1000 ? 0 : ms, ...args)) as typeof setTimeout);
});
afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    fetchSpy.mockRestore();
    timerSpy.mockRestore();
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("video terminal status polling", () => {
    for (const status of ["completed", "COMPLETED", "succeeded", "SuCcEeDeD", "success", "SUCCESS"]) {
        test(`${status} without a URL downloads /content with a bounded timeout`, async () => {
            const blob = videoBlob();
            adapter = async (request) => {
                if (request.url?.endsWith("/content")) {
                    expect(request.timeout).toBe(120_000);
                    expect(request.responseType).toBe("blob");
                    expect(request.headers.Authorization).toBe("Bearer fixture-only");
                    return response(request, blob);
                }
                return statusResponse(request, status);
            };
            expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "completed", result: { blob } });
            expectOnlyGets(2);
            expect(requests[1].url).toEndWith(`/videos/${task.id}/content`);
        });
        test(`${status} with a result URL downloads once`, async () => {
            const blob = videoBlob();
            adapter = async (request) => {
                if (request.responseType === "blob") {
                    expect(request.timeout).toBe(120_000);
                    expect(request.url).toEndWith(resultUrl);
                    return response(request, blob);
                }
                return statusResponse(request, status, resultUrl);
            };
            expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "completed", result: { blob } });
            expectOnlyGets(2);
        });
    }

    test("running with a URL and preview stays pending; preview-only does not imply completion", async () => {
        adapter = async (request) => response(request, {
            id: task.id, status: "RUNNING", url: resultUrl,
            preview: { url: "/previews/frame.png", mime: "image/png", step: 3, total: 10 },
            steps: { step: 3, total: 10 },
        });
        expect(await pollVideoGenerationTask(config, task)).toMatchObject({ status: "pending", preview: { mime: "image/png" }, steps: { step: 3, total: 10 } });
        adapter = async (request) => response(request, { id: task.id, preview: { url: resultUrl } });
        expect(await pollVideoGenerationTask(config, task)).toMatchObject({ status: "pending" });
        expectOnlyGets(2);
    });

    test("completion uses /content, never a preview URL", async () => {
        adapter = async (request) => request.url?.endsWith("/content")
            ? response(request, videoBlob())
            : response(request, { id: task.id, status: "SUCCESS", preview: { url: "https://fixture.invalid/preview.png" } });
        expect((await pollVideoGenerationTask(config, task)).status).toBe("completed");
        expectOnlyGets(2);
        expect(requests.some((request) => request.url?.includes("preview.png"))).toBe(false);
    });

    test("terminal failures are normalized and not retried", async () => {
        for (const status of ["FAILED", "CANCELLED", "Canceled"]) {
            adapter = async (request) => response(request, { id: task.id, status, error: { message: "fixture failure" } });
            expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "failed", error: "fixture failure" });
        }
        expectOnlyGets(3);
    });
});

describe("bounded status retry policy", () => {
    for (const failure of ["ERR_NETWORK", "ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "503"]) {
        test(`${failure} retries the status GET at most three times and never submits/cancels generation`, async () => {
            adapter = async (request) => {
                expect(request.timeout).toBe(15_000);
                throw failure === "503" ? httpError(request, 503) : transientError(request, failure);
            };
            await expect(waitForVideoGenerationTask(config, task)).rejects.toBeInstanceOf(Error);
            expectOnlyGets(3);
            expect(new Set(requests.map((request) => request.url)).size).toBe(1);
        });
    }

    test("transient failures can recover to a terminal result", async () => {
        adapter = async (request) => {
            if (requests.length === 1) throw transientError(request, "ECONNABORTED");
            if (requests.length === 2) throw httpError(request, 502);
            if (request.responseType === "blob") return response(request, videoBlob());
            return statusResponse(request, "COMPLETED");
        };
        const previews: unknown[] = [];
        expect((await waitForVideoGenerationTask(config, task, { onPreview: (preview) => previews.push(preview) })).blob).toBeInstanceOf(Blob);
        expect(previews).toEqual([null]);
        expectOnlyGets(4);
    });

    for (const status of [400, 401, 403, 404, 429]) {
        test(`HTTP ${status} fails immediately without retry`, async () => {
            adapter = async (request) => { throw httpError(request, status); };
            await expect(waitForVideoGenerationTask(config, task)).rejects.toBeInstanceOf(Error);
            expectOnlyGets(1);
        });
    }

    test("application-level error envelopes are not transport retries", async () => {
        adapter = async (request) => response(request, { code: 1, msg: "fixture application error" });
        await expect(pollVideoGenerationTask(config, task)).rejects.toThrow("fixture application error");
        expectOnlyGets(1);
    });

    test("Gemini status requests use the same bounds", async () => {
        adapter = async (request) => {
            expect(request.timeout).toBe(15_000);
            if (requests.length === 1) throw transientError(request, "ERR_NETWORK");
            if (request.responseType === "blob") return response(request, videoBlob());
            return response(request, { done: true, error: { message: "fixture Gemini failure" } });
        };
        expect(await pollVideoGenerationTask({ ...config, apiFormat: "gemini" }, { ...task, provider: "gemini", id: "operations/existing" })).toEqual({ status: "failed", error: "fixture Gemini failure" });
        expectOnlyGets(2);
    });
});

describe("downloads, fallback and validation", () => {
    for (const failure of ["ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"]) {
        test(`known result URL ${failure} falls back without a second storage fetch`, async () => {
            adapter = async (request) => {
                if (request.responseType !== "blob") return statusResponse(request, "success", resultUrl);
                expect(request.timeout).toBe(120_000);
                throw transientError(request, failure);
            };
            const result = await waitForVideoGenerationTask(config, task);
            expect(result).toEqual({ url: resultUrl, mimeType: "video/mp4" });
            expect(await storeGeneratedVideo(result)).toEqual({ url: resultUrl, storageKey: "", bytes: 0, mimeType: "video/mp4" });
            expect(fetchSpy).not.toHaveBeenCalled();
            expectOnlyGets(2);
        });
    }

    test("/content timeout fails in bounded time instead of waiting forever or canceling the remote task", async () => {
        adapter = async (request) => {
            if (request.responseType !== "blob") return statusResponse(request, "completed");
            expect(request.timeout).toBe(120_000);
            throw transientError(request, "ECONNABORTED");
        };
        await expect(waitForVideoGenerationTask(config, task)).rejects.toBeInstanceOf(Error);
        expectOnlyGets(2);
    });

    for (const path of ["url", "content"]) {
        for (const [kind, blob] of [
            ["image MIME", new Blob(["image bytes"], { type: "image/png" })],
            ["image header with fake video MIME", new Blob([pngBytes], { type: "video/mp4" })],
            ["JSON API error", new Blob([JSON.stringify({ error: { message: "fixture invalid video" } })], { type: "application/json" })],
        ] as const) {
            test(`${path} rejects ${kind} instead of falling back to a URL`, async () => {
                adapter = async (request) => request.responseType === "blob"
                    ? response(request, blob)
                    : statusResponse(request, "completed", path === "url" ? resultUrl : undefined);
                await expect(pollVideoGenerationTask(config, task)).rejects.toBeInstanceOf(Error);
                expectOnlyGets(2);
            });
        }
    }

    test("still-image result URLs and stored blobs remain rejected", async () => {
        const url = "https://fixture.invalid/final.PNG?token=fixture";
        adapter = async (request) => statusResponse(request, "completed", url);
        await expect(pollVideoGenerationTask(config, task)).rejects.toBeInstanceOf(Error);
        await expect(storeGeneratedVideo({ url })).rejects.toBeInstanceOf(Error);
        await expect(storeGeneratedVideo({ blob: new Blob([pngBytes], { type: "video/mp4" }) })).rejects.toBeInstanceOf(Error);
        expectOnlyGets(1);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("already downloaded blobs still use local media storage", async () => {
        const blob = videoBlob();
        const saved = { url: "blob:fixture", storageKey: "video:fixture", bytes: blob.size, mimeType: blob.type };
        const upload = spyOn(mediaStorage, "uploadMediaFile").mockResolvedValue(saved);
        try {
            expect(await storeGeneratedVideo({ blob, url: resultUrl })).toEqual(saved);
            expect(upload).toHaveBeenCalledWith(blob, "video");
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            upload.mockRestore();
        }
    });
});

describe("abort propagation", () => {
    test("an already aborted signal does not start a request", async () => {
        const controller = new AbortController();
        controller.abort("node-switch");
        await expect(pollVideoGenerationTask(config, task, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(requests).toHaveLength(0);
    });

    for (const stage of ["status", "url", "content"]) {
        test(`abort during ${stage} propagates unchanged without retry, fallback or remote cancel`, async () => {
            const controller = new AbortController();
            const canceled = new CanceledError("fixture aborted");
            adapter = async (request) => {
                if (stage !== "status" && request.responseType !== "blob") return statusResponse(request, "completed", stage === "url" ? resultUrl : undefined);
                expect(request.signal).toBe(controller.signal);
                return new Promise((_, reject) => {
                    request.signal?.addEventListener?.("abort", () => reject(canceled), { once: true });
                    queueMicrotask(() => controller.abort("node-switch"));
                });
            };
            await expect(waitForVideoGenerationTask(config, task, { signal: controller.signal })).rejects.toBe(canceled);
            expectOnlyGets(stage === "status" ? 1 : 2);
        });
    }

    test("abort interrupts retry backoff immediately and releases its listener", async () => {
        const controller = new AbortController();
        const add = spyOn(controller.signal, "addEventListener");
        const remove = spyOn(controller.signal, "removeEventListener");
        timerSpy.mockImplementation(((callback, ms, ...args) => {
            if (ms === 500) queueMicrotask(() => controller.abort("node-switch"));
            return realSetTimeout(callback, ms, ...args);
        }) as typeof setTimeout);
        adapter = async (request) => { throw transientError(request, "ERR_NETWORK"); };
        try {
            await expect(waitForVideoGenerationTask(config, task, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
            expectOnlyGets(1);
            expect(add.mock.calls.some(([event]) => event === "abort")).toBe(true);
            expect(remove.mock.calls.some(([event]) => event === "abort")).toBe(true);
        } finally {
            add.mockRestore();
            remove.mockRestore();
        }
    });

    test("normal retry delays also release abort listeners", async () => {
        const controller = new AbortController();
        const remove = spyOn(controller.signal, "removeEventListener");
        adapter = async (request) => {
            if (requests.length < 3) throw transientError(request, "ERR_NETWORK");
            return statusResponse(request, "running");
        };
        try {
            expect((await pollVideoGenerationTask(config, task, { signal: controller.signal })).status).toBe("pending");
            expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(2);
            expectOnlyGets(3);
        } finally {
            remove.mockRestore();
        }
    });

    test("only explicit user-stop retains the existing remote cancel behavior", async () => {
        const controller = new AbortController();
        const canceled = new CanceledError("user stopped");
        adapter = async (request) => {
            if (request.method === "post") {
                expect(request.url).toEndWith(`/videos/${task.id}/cancel`);
                expect(request.timeout).toBe(5000);
                return response(request, {});
            }
            controller.abort("user-stop");
            throw canceled;
        };
        await expect(waitForVideoGenerationTask(config, task, { signal: controller.signal })).rejects.toBe(canceled);
        expect(requests.map((request) => request.method)).toEqual(["get", "post"]);
    });
});

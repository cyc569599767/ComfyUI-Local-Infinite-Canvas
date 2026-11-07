import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import axios, { type InternalAxiosRequestConfig } from "axios";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { computeMediaSize, imageSizePresets, inferMediaRatio, inferMediaScale } = await import("../src/lib/media-size");
const { applyNodeConfigPatch } = await import("../src/lib/canvas/canvas-node-factory");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { requestGeneration } = await import("../src/services/api/image");
const { CanvasNodeType } = await import("../src/types/canvas");
import type { CanvasNodeData } from "../src/types/canvas";
// Same real gateway binder as the backend tests, without any server or GPU.
const { applyBindings, buildContext } = await import("../../../comfyui-gateway/src/bindings.js");
const { inferBindings } = await import("../../../comfyui-gateway/src/registry.js");
const { inferQwenOutputSize } = await import("../../../comfyui-gateway/src/qwen-output-size.js");
import legacy from "../../../comfyui-gateway/workflows/_archive/image-qwen21-t2i.json";

const config = { ...defaultConfig, channels: [], baseUrl: "http://127.0.0.1:8190/v1", apiKey: "local", model: "image-qwen21-t2i", imageModel: "image-qwen21-t2i", size: "1024x1024", count: "1", canvasImageCount: "1", imageMode: "" };
const entry = { bindings: inferBindings(legacy), outputSize: inferQwenOutputSize(legacy) };
let previousAdapter: typeof axios.defaults.adapter;
let requests: InternalAxiosRequestConfig[];
beforeEach(() => {
    previousAdapter = axios.defaults.adapter;
    requests = [];
    axios.defaults.adapter = async (request) => {
        requests.push(request);
        return { data: { data: [{ b64_json: "b2ZmbGluZQ==" }] }, status: 200, statusText: "OK", headers: {}, config: request };
    };
});
afterEach(() => { axios.defaults.adapter = previousAdapter; });
afterAll(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

function imageNode(): CanvasNodeData {
    return { id: "old-image", type: CanvasNodeType.Image, title: "Existing image", position: { x: 40, y: 80 }, width: 400, height: 400,
        metadata: { size: "1024x1024", model: config.model, content: "data:image/png;base64,ZXhpc3Rpbmc=", params: { resolution: 2048 }, count: 1 } };
}

for (const scale of ["1k", "2k", "4k"]) {
    for (const ratio of ["1:1", "16:9", "9:16", "3:2", "2:3"]) {
        test(`${scale} ${ratio}: preset -> node -> JSON request -> gateway canvas and sampler`, async () => {
            const size = computeMediaSize(scale, ratio);
            expect(size).toBe(imageSizePresets[scale][ratio]);
            expect(inferMediaScale(size)).toBe(scale);
            expect(inferMediaRatio(size)).toBe(ratio);
            const original = imageNode();
            const patched = applyNodeConfigPatch(original, { size });
            expect(original.metadata?.size).toBe("1024x1024");
            expect(patched.metadata?.content).toBe(original.metadata?.content);
            expect([patched.width, patched.height, patched.position]).toEqual([original.width, original.height, original.position]);
            const generation = buildGenerationConfig(config, patched, "image");
            expect(generation.size).toBe(size);
            await requestGeneration(generation, "offline size check");
            expect(requests).toHaveLength(1);
            expect(requests[0].url).toBe("http://127.0.0.1:8190/v1/images/generations");
            const body = JSON.parse(requests[0].data);
            expect(body.size).toBe(size);
            expect(body.model).toBe("image-qwen21-t2i");
            expect(body.params.resolution).toBe(2048);
            const graph = applyBindings(legacy, entry, buildContext(body));
            const [width, height] = size.split("x").map(Number);
            if (size === "1024x1024") {
                expect(graph["10"].inputs.latent_image).toEqual(["5", 2]);
                expect(graph["5"].inputs.resolution).toBe(1024);
            } else {
                expect([graph["13"].inputs.width, graph["13"].inputs.height]).toEqual([width, height]);
                expect(graph["10"].inputs.latent_image).toEqual(["14", 0]);
            }
        });
    }
}

test("custom dimensions align once to 16; auto leaves the native workflow untouched", async () => {
    await requestGeneration({ ...config, size: "1279x719" }, "offline");
    const body = JSON.parse(requests[0].data);
    expect(body.size).toBe("1280x720");
    const graph = applyBindings(legacy, entry, buildContext(body));
    expect([graph["13"].inputs.width, graph["13"].inputs.height]).toEqual([1280, 720]);
    await requestGeneration({ ...config, size: "auto" }, "offline");
    const automatic = JSON.parse(requests[1].data);
    expect(automatic.size).toBeUndefined();
    expect(applyBindings(legacy, entry, buildContext(automatic))["10"].inputs.latent_image).toEqual(["5", 2]);
});

test("bare ratio resolves to the same 1k dimensions; repeated setting changes do not reuse old size", async () => {
    for (const size of ["9:16", "2048x1360", "864x1536"]) await requestGeneration({ ...config, size }, "offline");
    expect(requests.map((request) => JSON.parse(request.data).size)).toEqual(["864x1536", "2048x1360", "864x1536"]);
});

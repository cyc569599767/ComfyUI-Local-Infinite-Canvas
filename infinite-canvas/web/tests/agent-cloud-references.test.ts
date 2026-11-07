import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import type { CanvasNodeData } from "../src/types/canvas";

// Browser storage is isolated in memory. No user settings, images or APIs.
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
const { prepareCloudReferences, MAX_CLOUD_IMAGE_PAYLOAD_BYTES } = await import("../src/lib/agent-cloud-references");
const image = "data:image/png;base64,YWJj";
const newerImage = "data:image/png;base64,ZGVm";
function node(id = "actual-node", type = "image", metadata = { content: image }): CanvasNodeData {
    return { id, type, title: "Current title", position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}
function reference(nodeId = "actual-node"): CanvasResourceReference {
    return { id: nodeId, nodeId, label: "图片 8", title: "Stale title", kind: "image", previewUrl: "https://unselected.invalid/stale.png", text: "Stale text", active: true };
}
function input(nodes = [node()], references = [reference()]) {
    return { text: "Describe @图片 8", attachments: [], references, readCanvas: () => ({ projectId: "A", nodes }) };
}
const upload = (id: string, dataUrl = image) => ({ id, name: id, url: dataUrl, dataUrl, mimeType: "image/png", size: 0 });

test("resolves node identity/current media and title instead of stale selected reference data", async () => {
    const current = node("actual-node", "image", { content: newerImage, storageKey: "image:current" } as never);
    const reads: unknown[] = [];
    const result = await prepareCloudReferences(input([current]), async value => { reads.push(value); return newerImage; });
    expect(reads).toEqual([{ storageKey: "image:current", url: newerImage }]);
    expect(result.requestText).toContain('"nodeId":"actual-node"');
    expect(result.requestText).toContain('"mention":"@图片 8"');
    expect(result.requestText).toContain('"title":"Current title"');
    expect(result.requestText).toContain('"imageIndex":1');
    expect(result.requestText).not.toContain("Stale");
    expect(result.attachments[0]).toMatchObject({ id: "canvas:actual-node", dataUrl: newerImage, size: 3 });
    expect(result.canvasReferences[0]).toMatchObject({ label: "图片 8", previewUrl: newerImage });
});

test("current text contents are sent, even if the selection cached an image kind", async () => {
    const current = node("actual-node", "text", { content: "Current body" });
    const result = await prepareCloudReferences(input([current]), async () => { throw new Error("must not read an image"); });
    expect(result.attachments).toEqual([]);
    expect(result.requestText).toContain('"kind":"text"');
    expect(result.requestText).toContain('"text":"Current body"');
    expect(result.canvasReferences[0].text).toBe("Current body");
});

test("duplicates collapse by node identity, not potentially ambiguous titles", async () => {
    const a = node("a"), b = node("b");
    const result = await prepareCloudReferences(input([a, b], [reference("a"), reference("a"), reference("b")]), async () => image);
    expect(result.attachments.map(item => item.id)).toEqual(["canvas:a", "canvas:b"]);
    expect(result.canvasReferences).toHaveLength(2);
});

test("missing and unsupported nodes reject without reading any cached external URL", async () => {
    let reads = 0;
    const reader = async () => { reads++; return image; };
    await expect(prepareCloudReferences(input([]), reader)).rejects.toThrow("已不存在");
    await expect(prepareCloudReferences(input([node("actual-node", "video")]), reader)).rejects.toThrow("暂不支持");
    await expect(prepareCloudReferences({ ...input(), readCanvas: () => null }, reader)).rejects.toThrow("画布");
    expect(reads).toBe(0);
});

test("storage read failure/unsupported bytes reject atomically and leave input draft untouched", async () => {
    const draft = input();
    await expect(prepareCloudReferences(draft, async () => { throw new Error("cannot load https://secret.invalid"); })).rejects.toThrow("画布图片读取失败");
    for (const data of ["https://external.invalid/image.png", "data:text/html;base64,YWJj", "data:image/svg+xml;base64,YWJj", "data:image/png;base64,"]) {
        await expect(prepareCloudReferences(draft, async () => data)).rejects.toThrow("格式");
    }
    expect(draft.references).toEqual([reference()]);
    expect(draft.attachments).toEqual([]);
});

test("uploaded and canvas images share the six-image ceiling before any reads", async () => {
    let reads = 0;
    const draft = { ...input(), attachments: Array.from({ length: 6 }, (_, i) => upload(String(i))) };
    await expect(prepareCloudReferences(draft, async () => { reads++; return image; })).rejects.toThrow("最多 6");
    expect(reads).toBe(0);
    const ok = await prepareCloudReferences({ ...draft, attachments: draft.attachments.slice(0, 5) }, async () => image);
    expect(ok.attachments).toHaveLength(6);
    expect(ok.requestText).toContain('"imageIndex":6');
});

test("actual serialized bytes count, not forged zero metadata; combined 30MB rejects", async () => {
    const large = "data:image/png;base64," + "A".repeat(Math.floor(MAX_CLOUD_IMAGE_PAYLOAD_BYTES / 2));
    await expect(prepareCloudReferences({ ...input(), attachments: [upload("first", large)] }, async () => large)).rejects.toThrow("30MB");
    await expect(prepareCloudReferences({ ...input([], []), attachments: [upload("huge", "data:image/png;base64," + "A".repeat(MAX_CLOUD_IMAGE_PAYLOAD_BYTES))] })).rejects.toThrow("30MB");
});

test("current project/node changes and Stop during asynchronous reads cannot dispatch stale references", async () => {
    for (const change of ["project", "node", "abort"]) {
        const nodes = [node()];
        let canvas = { projectId: "A", nodes };
        const controller = new AbortController();
        await expect(prepareCloudReferences({ ...input(), readCanvas: () => canvas, signal: controller.signal }, async () => {
            if (change === "project") canvas = { projectId: "B", nodes };
            if (change === "node") canvas = { projectId: "A", nodes: [node("actual-node", "image", { content: newerImage })] };
            if (change === "abort") controller.abort();
            return image;
        })).rejects.toThrow(change === "abort" ? "Canceled" : "已变化");
    }
});

test("prepared queued/history payload retains original bytes and text after canvas edits", async () => {
    let nodes = [node()];
    const prepared = await prepareCloudReferences({ ...input(), readCanvas: () => ({ projectId: "A", nodes }) }, async () => image);
    nodes = [node("actual-node", "image", { content: newerImage })];
    expect(prepared.attachments[0].dataUrl).toBe(image);
    expect(prepared.canvasReferences[0].previewUrl).toBe(image);
    expect(prepared.requestText).toContain('"nodeId":"actual-node"');
});

test("cloud submit prepares current refs and regenerates stored prompt without reinjecting context", () => {
    const source = readFileSync(new URL("../src/components/agent/agent-cloud-chat.tsx", import.meta.url), "utf8");
    expect(source).toContain("readCanvas: () => useAgentStore.getState().canvasContext?.snapshot");
    expect(source).toContain("queueRef.current.push(submission)");
    expect(source).toContain('source: "queued", submission: next');
    expect(source).toContain("requestText: plan.user.promptText ??");
    expect(source).toContain("canvasReferences: submission?.canvasReferences");
});

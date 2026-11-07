import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { generationRequestsToStop, hasNodeGeneration, planImageGeneration, type CanvasGenerationRequest } from "../src/lib/canvas/generation-ownership";
import { bindStepProgress, publishStepProgress, unbindStepProgress } from "../src/services/api/step-progress";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Execute the actual page callbacks with isolated state/transport dependencies,
// not a second implementation of the generation orchestration.
function callback(name: string, dependencies: Record<string, unknown>): any {
    let expression: ts.Node | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(tree);
    if (!expression) throw Error(`Page callback missing: ${name}`);
    const code = ts.transpileModule(`(${expression.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    return new Function(...Object.keys(dependencies), `return ${code}`)(...Object.values(dependencies));
}
const image = (id = "source", content = "original-image"): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 20, y: 30 }, width: 200, height: 160,
    metadata: { content, status: "success", generationDurationMs: 4321, generationType: "generation", storageKey: "original-key" } });
const makeRequest = (targetNodeId: string, originNodeId: string, runningNodeId = targetNodeId, controller = new AbortController()): CanvasGenerationRequest => ({ targetNodeId, originNodeId, runningNodeId, controller });

test("new image owns its request; overwrite/empty image still owns itself", () => {
    expect(planImageGeneration(image(), "source", false, () => "child")).toEqual({ targetNodeId: "child", reuseImageNode: false, detached: true, runningNodeId: "child" });
    for (const [node, overwrite] of [[image(), true], [image("source", ""), false]] as const) {
        expect(planImageGeneration(node, "source", overwrite, () => "child")).toEqual({ targetNodeId: "source", reuseImageNode: true, detached: false, runningNodeId: "source" });
    }
});

test("origin is provenance only; stopping one child never selects its sibling", () => {
    const a = makeRequest("a", "source"), b = makeRequest("b", "source");
    expect(hasNodeGeneration([a, b], "source")).toBe(false);
    expect(hasNodeGeneration([a, b], "a")).toBe(true);
    expect(generationRequestsToStop([a, b], "source")).toEqual([]);
    expect(generationRequestsToStop([a, b], "a")).toEqual([a]);
    a.controller.abort();
    expect(hasNodeGeneration([a, b], "a")).toBe(false);
    expect(hasNodeGeneration([a, b], "b")).toBe(true);
});

test("shared config/card controller cleanup selects only its own request group", () => {
    const controller = new AbortController();
    const parent = makeRequest("config", "config", "config", controller);
    const child = makeRequest("child", "config", "config", controller);
    const sibling = makeRequest("sibling", "config");
    expect(generationRequestsToStop([parent, child, sibling], "child")).toEqual([parent, child]);
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function harness({ overwrite = false, empty = false, count = 1, preparation = Promise.resolve() } = {}) {
    const original = image("source", empty ? "" : "original-image");
    const nodesRef = { current: [original] as CanvasNodeData[] };
    const requests = new Map<string, CanvasGenerationRequest>();
    const starts = new Map<string, number>();
    let running: string | null = null;
    let selected = new Set<string>();
    let dialog: string | null = null;
    let id = 0;
    const pending: Array<{ signal: AbortSignal; resolve: (images: any[]) => void; reject: (reason: Error) => void }> = [];
    const notifications: string[] = [];
    const update = (current: any, value: any) => typeof value === "function" ? value(current) : value;
    const env: Record<string, any> = {
        nodesRef, connectionsRef: { current: [] }, generationRequestsRef: { current: requests }, generationStartedAtRef: { current: starts },
        generationStepTimersRef: { current: new Map() }, generationStepTracksRef: { current: new Map() },
        window: { clearTimeout() {}, setTimeout: () => 1 },
        setNodes: (value: any) => { nodesRef.current = update(nodesRef.current, value); },
        setRunningNodeId: (value: any) => { running = update(running, value); },
        setSelectedNodeIds: (value: Set<string>) => { selected = value; }, setSelectedConnectionId() {},
        setDialogNodeId: (value: string | null) => { dialog = value; }, setConnections() {}, setExpandedBatchNodeIds() {},
        bindStepProgress, unbindStepProgress, generationRequestsToStop, hasNodeGeneration, planImageGeneration,
        refreshGenerationTimer() {}, CanvasNodeType,
        NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error", NODE_STATUS_IDLE: "idle",
        NODE_DEFAULT_SIZE: { image: { width: 200, height: 160 }, config: { width: 200, height: 160 }, text: { width: 200, height: 160 } },
        effectiveConfig: { nodeRegenerateBehavior: overwrite ? "overwrite" : "new-node" },
        buildGenerationConfig: () => ({ model: "fixture", count: String(count), size: "1024x1024" }),
        isAiConfigReady: () => true, openConfigDialog() {}, getNodeDefinition: () => undefined, nanoid: () => `new-${++id}`,
        buildNodeGenerationInputs: () => [], buildNodeGenerationContext: (_id: string, _nodes: unknown, _connections: unknown, prompt: string) => ({ prompt, referenceImages: [], loras: [] }),
        hydrateNodeGenerationContext: async (context: unknown) => { await preparation; return context; },
        resolveMetadataReferences: async () => [], dedupeReferenceImages: (...groups: unknown[][]) => groups.flat(),
        getGenerationCount: Number, buildImageGenerationMetadata: () => ({ model: "fixture", count }), buildGeneratedNodeConnections: () => [],
        requestGeneration: (_config: unknown, _prompt: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => { pending.push({ signal, resolve, reject }); }),
        // Keep this transport unresolved on abort, to test late responses/errors.
        uploadImage: async (data: string) => ({ url: data, storageKey: "new-key", width: 512, height: 512, bytes: 10, mimeType: "image/png" }),
        fitNodeSize: () => ({ width: 200, height: 200 }),
        isGenerationCanceled: (error: Error) => error.name === "AbortError", isVideoTaskFailed: () => false,
        t: (key: string) => key, message: { error: (message: string) => notifications.push(message) },
        modal: { confirm: (options: { onOk: () => void }) => options.onOk() },
    };
    env.startGenerationRequest = callback("startGenerationRequest", env);
    env.finishGenerationRequest = callback("finishGenerationRequest", env);
    const generate = callback("handleGenerateNode", env);
    const stop = callback("stopGenerationByRunningId", env);
    env.stopGenerationByRunningId = stop;
    const confirmStop = callback("confirmStopGeneration", env);
    const isRunning = () => callback("hasActiveGeneration", env);
    cleanups.push(() => { for (const request of requests.values()) unbindStepProgress(request.controller.signal); });
    return { original, nodesRef, requests, starts, pending, notifications, generate, stop, confirmStop, isRunning,
        get running() { return running; }, get selected() { return selected; }, get dialog() { return dialog; } };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test("actual page: only new image gets running/progress, stop clears it and preserves original", async () => {
    const h = harness();
    const before = structuredClone(h.original);
    const done = h.generate("source", "image", "fixture prompt");
    await flush();
    const child = h.nodesRef.current.find((node) => node.id !== "source")!;
    expect(child).toBeDefined();
    expect(h.requests.size).toBe(1);
    expect(hasNodeGeneration(h.requests.values(), "source")).toBe(false);
    expect(hasNodeGeneration(h.requests.values(), child.id)).toBe(true);
    expect(h.isRunning()("source")).toBe(false);
    expect(h.isRunning()(child.id)).toBe(true);
    expect(h.running).toBe(child.id);
    expect(h.selected).toEqual(new Set([child.id]));
    expect(h.dialog).toBe(child.id);
    expect(h.nodesRef.current[0]).toEqual(before);
    publishStepProgress(h.pending[0].signal, { requestId: "fixture", step: 3, total: 8 });
    expect(h.nodesRef.current.find((node) => node.id === child.id)?.metadata?.stepProgress).toEqual({ step: 3, total: 8 });
    expect(h.nodesRef.current[0]).toEqual(before);
    h.confirmStop(child.id);
    expect(h.pending[0].signal.aborted).toBe(true);
    expect(h.requests.size).toBe(0);
    expect(h.starts.size).toBe(0);
    expect(h.nodesRef.current[0]).toEqual(before);
    const stopped = h.nodesRef.current.find((node) => node.id === child.id)!;
    expect(stopped.metadata?.status).toBe("idle");
    expect(stopped.metadata?.stepProgress).toBeUndefined();
    expect(stopped.metadata?.images?.[0].status).toBe("error");
    // Late server success must not revive a stopped image.
    h.pending[0].resolve([{ dataUrl: "late-image" }]);
    await done;
    expect(h.nodesRef.current.find((node) => node.id === child.id)).toEqual(stopped);
    expect(h.notifications).toEqual([]);
});

test("actual page: simultaneous children are independent; finishing/stopping one leaves the other active", async () => {
    const h = harness();
    const first = h.generate("source", "image", "one"); await flush();
    const a = h.nodesRef.current[1].id;
    const second = h.generate("source", "image", "two"); await flush();
    const b = h.nodesRef.current[2].id;
    expect(h.requests.size).toBe(2);
    h.stop(a);
    expect(h.pending[0].signal.aborted).toBe(true);
    expect(h.pending[1].signal.aborted).toBe(false);
    h.pending[0].reject(Error("late transport failure")); await first;
    expect(hasNodeGeneration(h.requests.values(), b)).toBe(true);
    expect(h.running).toBe(b);
    h.pending[1].resolve([{ dataUrl: "completed-image" }]); await second;
    expect(h.requests.size).toBe(0);
    expect(h.starts.size).toBe(0);
    expect(h.nodesRef.current[0]).toEqual(h.original);
    expect(h.nodesRef.current.find((node) => node.id === b)?.metadata?.status).toBe("success");
    expect(h.notifications).toEqual([]);
});

test("actual page: failure belongs to new node, not source; overwrite and empty paths remain stoppable", async () => {
    const failed = harness();
    const result = failed.generate("source", "image", "bad"); await flush();
    failed.pending[0].reject(Error("fixture failure")); await result;
    expect(failed.nodesRef.current[0]).toEqual(failed.original);
    expect(failed.nodesRef.current[1].metadata?.status).toBe("error");
    expect(failed.requests.size).toBe(0);
    for (const options of [{ overwrite: true }, { empty: true }]) {
        const h = harness(options);
        const done = h.generate("source", "image", "self"); await flush();
        expect(h.nodesRef.current).toHaveLength(1);
        expect(hasNodeGeneration(h.requests.values(), "source")).toBe(true);
        h.stop("source");
        expect(h.pending[0].signal.aborted).toBe(true);
        h.pending[0].resolve([{ dataUrl: "ignored" }]); await done;
        expect(h.nodesRef.current[0].metadata?.status).toBe("idle");
        expect(h.requests.size).toBe(0);
    }
});

test("actual page: preparation failure never attaches a timer/status to the original", async () => {
    const h = harness({ preparation: Promise.reject(Error("reference unavailable")) });
    await h.generate("source", "image", "fixture");
    expect(h.nodesRef.current).toEqual([h.original]);
    expect(h.pending).toHaveLength(0);
    expect(h.requests.size).toBe(0);
    expect(h.starts.size).toBe(0);
    expect(h.running).toBeNull();
});

test("actual page: stopping partial batch keeps successful images and cancels pending ones", async () => {
    const h = harness({ count: 2 });
    const done = h.generate("source", "image", "batch"); await flush();
    const child = h.nodesRef.current[1].id;
    h.pending[0].resolve([{ dataUrl: "keep-completed" }]); await flush();
    h.stop(child);
    h.pending[1].reject(Error("late cancellation failure")); await done;
    const node = h.nodesRef.current.find((node) => node.id === child)!;
    expect(node.metadata?.content).toBe("keep-completed");
    expect(node.metadata?.images?.map((image) => image.status)).toEqual(["success", "error"]);
    expect(h.nodesRef.current[0]).toEqual(h.original);
    expect(h.notifications).toEqual([]);
});

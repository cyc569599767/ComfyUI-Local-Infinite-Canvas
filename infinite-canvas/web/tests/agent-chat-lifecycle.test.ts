import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyApprovedCanvasOps } from "../src/lib/agent-chat-lifecycle";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";

const ops: CanvasAgentOp[] = [{ type: "add_node", nodeType: "text", title: "approved fixture" }];
function context(projectId: string, writes: string[], label: string) {
    const snapshot: CanvasAgentSnapshot = {
        projectId, title: projectId, nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 },
    };
    return { snapshot, applyOps: (received: CanvasAgentOp[]) => { expect(received).toBe(ops); writes.push(label); return snapshot; } };
}
function deferredApproval() {
    let resolve!: (approved: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    return { promise, resolve };
}

for (const destination of ["B", null]) {
    test(`pending approval rejects navigation to ${destination ?? "a non-canvas page"} without applying either callback`, async () => {
        const writes: string[] = [];
        let current: ReturnType<typeof context> | null = context("A", writes, "old A");
        const approval = deferredApproval();
        const result = applyApprovedCanvasOps({ ops, summary: "fixture", confirmTools: true, readContext: () => current, requestApproval: () => approval.promise, signal: new AbortController().signal });
        current = destination ? context(destination, writes, "current B") : null;
        approval.resolve(true);
        expect(await result).toHaveProperty("error");
        expect(writes).toEqual([]);
    });
}

test("accepted same-project approval applies the current context, not the captured stale callback", async () => {
    const writes: string[] = [];
    let current = context("A", writes, "old A");
    const approval = deferredApproval();
    const result = applyApprovedCanvasOps({ ops, summary: "fixture", confirmTools: true, readContext: () => current, requestApproval: () => approval.promise, signal: new AbortController().signal });
    current = context("A", writes, "fresh A");
    approval.resolve(true);
    expect(await result).toEqual({ snapshot: current.snapshot });
    expect(writes).toEqual(["fresh A"]);
});

test("rejecting approval never mutates the canvas", async () => {
    const writes: string[] = [];
    const current = context("A", writes, "A");
    const result = await applyApprovedCanvasOps({ ops, summary: "fixture", confirmTools: true, readContext: () => current, requestApproval: async () => false, signal: new AbortController().signal });
    expect(result).toHaveProperty("error");
    expect(writes).toEqual([]);
});

test("stop while waiting for approval prevents writes even if acceptance resolves afterwards", async () => {
    const writes: string[] = [];
    const current = context("A", writes, "A");
    const approval = deferredApproval();
    const controller = new AbortController();
    const result = applyApprovedCanvasOps({ ops, summary: "fixture", confirmTools: true, readContext: () => current, requestApproval: () => approval.promise, signal: controller.signal });
    controller.abort();
    approval.resolve(true);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toEqual([]);
});

test("automatic confirmation still applies without requesting approval", async () => {
    const writes: string[] = [];
    const current = context("A", writes, "A");
    const result = await applyApprovedCanvasOps({ ops, summary: "fixture", confirmTools: false, readContext: () => current, requestApproval: async () => { throw new Error("must not request approval"); }, signal: new AbortController().signal });
    expect(result).toEqual({ snapshot: current.snapshot });
    expect(writes).toEqual(["A"]);
});

// Source integration guards supplement (not replace) the real mounted UI tests:
// queued B must not consume a newer unsent composer draft C or its attachments.
const cloudChatSource = readFileSync(new URL("../src/components/agent/agent-cloud-chat.tsx", import.meta.url), "utf8");
test("all runChat entry points retain prepared refs and only successful submission consumes its captured draft", () => {
    expect(cloudChatSource).toContain('runChat(next.text, next.attachments, { source: "queued", submission: next })');
    expect(cloudChatSource).toContain('runChat(text, prepared.attachments, { source: "submit", submission })');
    expect(cloudChatSource).toContain('{ source: "regenerate", replaceHistory: plan.prefix, submission:');
    expect(cloudChatSource).toContain('draftRef.current.prompt === prompt && draftRef.current.attachments === attachments && state.canvasReferences === references');
    expect(cloudChatSource).toContain('state.setAgentState({ canvasReferences: [] })');
    expect(cloudChatSource).not.toContain('if (!replaceHistory) { setPrompt(""); setAttachments([]); }');
});
test("the tool execution uses the guarded approval path with a fresh store read and turn abort signal", () => {
    expect(cloudChatSource).toContain("const applied = await applyApprovedCanvasOps({");
    expect(cloudChatSource).toContain("readContext: () => useAgentStore.getState().canvasContext");
    expect(cloudChatSource).toContain("executeTool(name, input, controller.signal)");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanvasToolRequest } from "./operations.js";
import { toolInputSchemas } from "./schemas.js";

function opsOf(name: Parameters<typeof buildCanvasToolRequest>[0], input: Record<string, unknown>) {
    const request = buildCanvasToolRequest(name, input, null);
    return (request.input as { ops: Array<Record<string, any>> }).ops;
}

test("generation flow reuses referenced nodes when the prompt only mentions them", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "@[node:text-1]", referenceNodeIds: ["text-1"], title: "Flow", autoRun: true });
    const addedTextNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(addedTextNodes.length, 0);
    assert.equal(ops.filter((op) => op.type === "connect_nodes" && op.fromNodeId === "text-1" && String(op.toNodeId).startsWith("config-")).length, 1);
    assert.match(String(config?.metadata?.prompt), /^@\[node:text-1\]$/);
    assert.equal(runs.length, 1);
});

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", referenceNodeIds: ["text-1"], autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.match(String(config?.metadata?.prompt), /@\[node:text-/);
});

// 工作台是前端内建节点，Agent 必须能建出来——否则「全部出片后建一张剪辑台」这类
// 提示词会在校验层就被拒掉，模型只会看到一句莫名其妙的参数错误。
test("add_node accepts the workbench node type with a workbenchKind", () => {
    const parsed = toolInputSchemas.canvas_apply_ops.safeParse({
        ops: [{ type: "add_node", nodeType: "workbench", title: "剪辑台", metadata: { workbenchKind: "video-editor" } }],
    });
    assert.equal(parsed.success, true);
});

test("add_node still rejects node types the canvas does not have", () => {
    const parsed = toolInputSchemas.canvas_apply_ops.safeParse({ ops: [{ type: "add_node", nodeType: "not-a-node" }] });
    assert.equal(parsed.success, false);
});

test("canvas_create_node accepts workbench and keeps its kind in metadata", () => {
    const parsed = toolInputSchemas.canvas_create_node.parse({ nodeType: "workbench", metadata: { workbenchKind: "video-editor" } });
    const ops = opsOf("canvas_create_node", parsed as Record<string, unknown>);
    const node = ops.find((op) => op.type === "add_node");
    assert.equal(node?.nodeType, "workbench");
    // workbenchKind 必须原样落到节点上：前端按它分发面板，丢了就变成故事分镜导演台。
    assert.equal(node?.metadata?.workbenchKind, "video-editor");
});

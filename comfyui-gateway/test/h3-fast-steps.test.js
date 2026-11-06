import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatewayDir = path.join(root, "comfyui-gateway");

test("fork fast-draft public copy matches its shipped FL2VA four-step graph", () => {
    const workflow = JSON.parse(fs.readFileSync(path.join(gatewayDir, "workflows", "h3-fast-draft.json"), "utf8"));
    const registry = JSON.parse(fs.readFileSync(path.join(gatewayDir, "workflows", "registry.json"), "utf8"));
    const fast = registry.workflows.find(entry => entry.id === "video-h3-fast");
    const sampler = Object.values(workflow).find(node => node?.class_type === "BasicScheduler");
    assert.ok(sampler, "fork draft must retain the verified native FL2VA scheduler");
    assert.equal(sampler.inputs.steps, 4);
    assert.ok(Object.values(workflow).some(node => node?.class_type === "MiniMaxH3ImageToVideo"));
    assert.ok(!Object.values(workflow).some(node => node?.class_type === "FastH3BenchmarkSampler"));
    assert.match(fast.description, /FL2VA Turbo 4 步/);
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const forkNote = changelog.split("## Fork 同步说明")[1]?.split("## v0.24.13")[0] || "";
    assert.match(forkNote, /FL2VA Turbo \*\*4 步\*\*/);
    assert.match(forkNote, /上游历史/);
});

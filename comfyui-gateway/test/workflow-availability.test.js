import assert from "node:assert/strict";
import test from "node:test";

import { missingNodeClasses, workflowAvailabilityProblem } from "../src/workflow-availability.js";

const entry = { id: "image-qwen21", name: "Qwen Image 2.1" };

test("blocks an unavailable workflow with its concrete problems", () => {
  const setup = {
    workflowStatus: () => ({ available: false, problems: [{ type: "model", message: "缺少 diffusion_models/qwen.safetensors" }] }),
  };
  const problem = workflowAvailabilityProblem(setup, entry);
  assert.equal(problem.code, "workflow_unavailable");
  assert.match(problem.message, /qwen\.safetensors/);
  assert.equal(problem.details.workflowId, entry.id);
});

test("blocks only the unavailable variant and keeps other modes usable", () => {
  const setup = {
    workflowStatus: () => ({
      available: true,
      problems: [],
      variants: { edit: { available: true, problems: [] }, outpaint: { available: false, problems: [{ message: "缺少 outpaint LoRA" }] } },
    }),
  };
  assert.equal(workflowAvailabilityProblem(setup, entry, { mode: "edit" }), null);
  const problem = workflowAvailabilityProblem(setup, entry, { mode: "outpaint" });
  assert.equal(problem.code, "workflow_mode_unavailable");
  assert.match(problem.message, /outpaint LoRA/);
  assert.equal(problem.details.mode, "outpaint");
});

test("allows hidden upscale tools and unknown modes without blocking", () => {
  const setup = { workflowStatus: () => ({ available: false, problems: [{ message: "missing" }] }) };
  assert.equal(workflowAvailabilityProblem(setup, entry, { allowUnavailable: true }), null);
  const available = { workflowStatus: () => ({ available: true, problems: [], variants: {} }) };
  assert.equal(workflowAvailabilityProblem(available, entry, { mode: "other" }), null);
});

test("is a no-op only when setup exposes no status provider", () => {
  assert.equal(workflowAvailabilityProblem({}, entry), null);
  const checking = workflowAvailabilityProblem({ workflowStatus: () => ({ available: false, checking: true, problems: [{ message: "正在扫描" }] }) }, entry);
  assert.equal(checking.code, "workflow_checking");
  assert.match(checking.message, /正在检查可用性/);
});

test("missingNodeClasses reports each absent class once, in workflow order", () => {
  const workflow = {
    1: { class_type: "LoadVideo" },
    2: { class_type: "RelayVSRConditioning" },
    3: { class_type: "VSRDecode" },
    4: { class_type: "RelayVSRConditioning" },
  };
  const present = new Set(["LoadVideo"]);
  assert.deepEqual(missingNodeClasses(workflow, (name) => present.has(name)), ["RelayVSRConditioning", "VSRDecode"]);
});

test("missingNodeClasses tolerates a node without class_type and a missing probe", () => {
  const workflow = { 1: { class_type: "SaveVideo" }, 2: { inputs: {} }, 3: null };
  assert.deepEqual(missingNodeClasses(workflow, () => true), []);
  assert.deepEqual(missingNodeClasses(workflow, undefined), [], "没有节点表时不能把所有工作流判死");
  assert.deepEqual(missingNodeClasses(null, () => false), []);
});

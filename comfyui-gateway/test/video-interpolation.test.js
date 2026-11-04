import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createVideoInterpolator } from "../src/video-interpolation.js";

const REAL_WORKFLOW = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "workflows",
  "_internal",
  "video-rife.json",
);

// 直接复制真实内嵌工作流：结构漂移（例如又出现未安装的第三方类名）会让这些测试失败。
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rife-test-"));
  const workflowDir = path.join(root, "_internal");
  await fsp.mkdir(workflowDir, { recursive: true });
  const workflow = await fsp.readFile(REAL_WORKFLOW, "utf8");
  await fsp.writeFile(path.join(workflowDir, "video-rife.json"), workflow);
  return root;
}

// 真实 ComfyUI 的 object_info：核心插帧节点 + 一个已安装的权重。
function objectInfo({ models = ["rife_v4.26.safetensors"] } = {}) {
  return {
    FrameInterpolationModelLoader: { input: { required: { model_name: ["COMBO", { options: models }] } } },
    FrameInterpolate: { input: { required: { interp_model: ["INTERP_MODEL", {}], images: ["IMAGE", {}], multiplier: ["INT", {}] } } },
  };
}

function fakeComfy(capture, { info = objectInfo() } = {}) {
  return {
    async objectInfo() {
      capture.objectInfoCalls = (capture.objectInfoCalls || 0) + 1;
      return info;
    },
    async uploadImage() {
      return { name: "input.mp4", subfolder: "" };
    },
    async submit(workflow) {
      capture.workflow = workflow;
      return { promptId: "p1" };
    },
    async history(promptId) {
      return {
        [promptId]: {
          status: { status_str: "success", completed: true },
          outputs: { "3": { videos: [{ filename: "out.mp4", type: "output" }] } },
        },
      };
    },
    async view() {
      return { buffer: Buffer.from("video"), contentType: "video/mp4" };
    },
  };
}

test("interpolation follows the source frame rate", async () => {
  const root = await fixture();
  try {
    const capture = {};
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    const result = await interpolator.interpolate({
      comfy: fakeComfy(capture),
      buffer: Buffer.from("input"),
      multiplier: 2,
      sourceFps: 30,
      requestId: "req1",
    });
    assert.equal(result.mimeType, "video/mp4");
    assert.equal(capture.workflow["3"].inputs.frame_rate, 60);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("interpolation only uses installed core nodes and injects the discovered model", async () => {
  const root = await fixture();
  try {
    const capture = {};
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await interpolator.interpolate({
      comfy: fakeComfy(capture),
      buffer: Buffer.from("input"),
      multiplier: 2,
      requestId: "req-nodes",
    });
    const classes = Object.values(capture.workflow).map((node) => node.class_type);
    assert.ok(classes.includes("FrameInterpolationModelLoader"));
    assert.ok(classes.includes("FrameInterpolate"));
    // 关键回归：未安装的第三方插件类名会让 ComfyUI 直接 missing_node_type。
    assert.ok(!classes.includes("RIFE VFI"));
    const loader = Object.values(capture.workflow).find((node) => node.class_type === "FrameInterpolationModelLoader");
    assert.equal(loader.inputs.model_name, "rife_v4.26.safetensors");
    const interp = Object.values(capture.workflow).find((node) => node.class_type === "FrameInterpolate");
    assert.equal(interp.inputs.multiplier, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("prefers the recommended model when several are installed", async () => {
  const root = await fixture();
  try {
    const capture = {};
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await interpolator.interpolate({
      comfy: fakeComfy(capture, {
        info: objectInfo({ models: ["rife_v4.26_heavy.safetensors", "rife_v4.26_lite.safetensors", "rife_v4.26.safetensors"] }),
      }),
      buffer: Buffer.from("input"),
      multiplier: 2,
      requestId: "req-pick",
    });
    const loader = Object.values(capture.workflow).find((node) => node.class_type === "FrameInterpolationModelLoader");
    assert.equal(loader.inputs.model_name, "rife_v4.26.safetensors");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("missing interpolation weights report an actionable message", async () => {
  const root = await fixture();
  try {
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await assert.rejects(
      () =>
        interpolator.interpolate({
          comfy: fakeComfy({}, { info: objectInfo({ models: [] }) }),
          buffer: Buffer.from("input"),
          multiplier: 2,
          requestId: "req-nomodel",
        }),
      (error) => /资源中心/.test(error.message) && /rife_v4\.26/.test(error.message),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("ComfyUI without core interpolation nodes reports an upgrade hint", async () => {
  const root = await fixture();
  try {
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await assert.rejects(
      () =>
        interpolator.interpolate({
          comfy: fakeComfy({}, { info: { SomeOtherNode: {} } }),
          buffer: Buffer.from("input"),
          multiplier: 2,
          requestId: "req-old",
        }),
      (error) => /FrameInterpolate/.test(error.message) && /升级 ComfyUI/.test(error.message),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("interpolation timeout cancels the running ComfyUI task", async () => {
  const root = await fixture();
  try {
    let cancelled = "";
    const comfy = {
      async objectInfo() {
        return objectInfo();
      },
      async uploadImage() {
        return { name: "input.mp4", subfolder: "" };
      },
      async submit() {
        return { promptId: "p-timeout" };
      },
      async cancel(promptId) {
        cancelled = promptId;
      },
      async history() {
        return null;
      },
      async view() {
        return { buffer: Buffer.from("video"), contentType: "video/mp4" };
      },
    };
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await assert.rejects(
      () => interpolator.interpolate({
        comfy,
        buffer: Buffer.from("input"),
        multiplier: 2,
        requestId: "req-timeout",
        timeoutMs: 1,
      }),
      (error) => /插帧超时/.test(error.message),
    );
    assert.equal(cancelled, "p-timeout");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("falls back to 24fps when the source rate is unknown", async () => {
  const root = await fixture();
  try {
    const capture = {};
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await interpolator.interpolate({
      comfy: fakeComfy(capture),
      buffer: Buffer.from("input"),
      multiplier: 3,
      sourceFps: 0,
      requestId: "req2",
    });
    assert.equal(capture.workflow["3"].inputs.frame_rate, 72);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

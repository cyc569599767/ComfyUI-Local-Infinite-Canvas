import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createLocalOutputReader } from "../src/local-output.js";
import { runWorkflow } from "../src/runner.js";

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "comfy-local-output-"));
  const output = path.join(root, "output", "video");
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(output, "clip.mp4"), Buffer.from("fake-mp4-bytes"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test("本地输出读取只接受 output 目录内的文件", async (t) => {
  const comfyDir = await fixture(t);
  const read = createLocalOutputReader({ comfyDir });
  const hit = await read({ filename: "clip.mp4", subfolder: "video", type: "output" });
  assert.equal(hit?.buffer.toString(), "fake-mp4-bytes");
  assert.equal(hit?.contentType, "video/mp4");
  // input/temp 是用户上传或临时预览，不属于生成结果。
  assert.equal(await read({ filename: "clip.mp4", subfolder: "video", type: "input" }), null);
  assert.equal(await read({ filename: "clip.mp4", subfolder: "video", type: "temp" }), null);
  assert.equal(await read({ filename: "missing.mp4", subfolder: "video", type: "output" }), null);
  assert.equal(await read(null), null);
});

test("本地输出读取拒绝目录穿越与绝对路径", async (t) => {
  const comfyDir = await fixture(t);
  const read = createLocalOutputReader({ comfyDir });
  assert.equal(await read({ filename: "../../../../etc/passwd", subfolder: "", type: "output" }), null);
  assert.equal(await read({ filename: "clip.mp4", subfolder: "../../..", type: "output" }), null);
  assert.equal(await read({ filename: path.join(comfyDir, "output", "video", "clip.mp4"), subfolder: "", type: "output" }), null);
  // 没有 comfyDir 时不提供回退，不能凭猜测读盘。
  assert.equal(createLocalOutputReader({ comfyDir: "" }), null);
});

// 复现线上故障：ComfyUI 已 execution_success，但 /view 返回 200 却一个字节都不发。
// 修复前任务以 output_download_failed 失败，画布永远收不到已生成的结果。
test("/view 挂住但文件已落盘时，任务仍能拿到结果", async (t) => {
  const comfyDir = await fixture(t);
  const readLocalOutput = createLocalOutputReader({ comfyDir });
  const comfy = {
    async submit() {
      return { promptId: "prompt-local-fallback" };
    },
    async history() {
      // comfy-client 已经把 /history/:id 的外层按 promptId 拆掉了，这里返回的应是节点内容。
      return {
        status: { status_str: "success", completed: true },
        outputs: { 9: { images: [{ filename: "clip.mp4", subfolder: "video", type: "output" }] } },
      };
    },
    async view() {
      throw Object.assign(new Error("terminated"), { code: "comfy_unreachable" });
    },
  };
  const warnings = [];
  const result = await runWorkflow({
    entry: { name: "video-relayvsr-upscale", type: "video", workflow: { 1: { class_type: "LoadVideo", inputs: {} } }, bindings: {}, defaults: {}, presets: {} },
    context: { mode: "upscale", params: {} },
    comfy,
    pollIntervalMs: 5,
    timeoutMs: 5000,
    logger: { warn: (line) => warnings.push(String(line)), info: (line) => warnings.push(String(line)) },
    readLocalOutput,
  });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].buffer.toString(), "fake-mp4-bytes");
  assert.equal(result.files[0].filename, "clip.mp4");
  // 本地优先时走 info（跳过 /view），HTTP 失败后回退才走 warn；两者都必须留痕，
  // 否则 /view 长期异常会静默藏在正常日志里。
  assert.ok(warnings.some((line) => /本地输出目录读取/.test(line)), "回退必须留痕，便于发现 /view 异常");
});

test("没有本地文件可回退时仍然报 output_download_failed 并带上文件名", async (t) => {
  const comfyDir = await fixture(t);
  const readLocalOutput = createLocalOutputReader({ comfyDir });
  const comfy = {
    async submit() {
      return { promptId: "prompt-no-file" };
    },
    async history() {
      return {
        status: { status_str: "success", completed: true },
        outputs: { 9: { images: [{ filename: "absent.mp4", subfolder: "video", type: "output" }] } },
      };
    },
    async view() {
      throw Object.assign(new Error("terminated"), { code: "comfy_unreachable" });
    },
  };
  await assert.rejects(
    () =>
      runWorkflow({
        entry: { name: "video-relayvsr-upscale", type: "video", workflow: { 1: { class_type: "LoadVideo", inputs: {} } }, bindings: {}, defaults: {}, presets: {} },
        context: { mode: "upscale", params: {} },
        comfy,
        pollIntervalMs: 5,
        timeoutMs: 5000,
        readLocalOutput,
      }),
    (error) => {
      assert.equal(error.code, "output_download_failed");
      assert.equal(error.details.filename, "absent.mp4");
      assert.equal(error.details.subfolder, "video");
      return true;
    },
  );
});

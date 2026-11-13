import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyFreeInputs } from "../src/free-workflows.js";
import { bindingSummary, detectFreeBindings } from "../src/ui-workflow.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, "..", "workflows");

function readWorkflow(name) {
  return JSON.parse(fs.readFileSync(path.join(WORKFLOWS, `${name}.json`), "utf8"));
}

// 曾经的 bug：applyFreeInputs 的签名里没有 uploadedAudios，参考音频被静默丢弃，
// LoadAudio 仍指向工作流里写死的 reference.flac，ComfyUI 报
// "Custom validation failed for node 6"。这组测试锁定音频写回。

test("音色克隆工作流的参考音频能被扫描到", () => {
  const workflow = readWorkflow("audio-qwen3-tts-voice-clone");
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "audio");
  assert.ok(Array.isArray(bindings.audios), "bindings 应带 audios 数组");
  assert.equal(bindings.audios.length, 1);
  assert.equal(bindings.audios[0].node, "6");
  assert.equal(bindings.audios[0].input, "audio");

  // summary 要给前端一个 audioInputs 计数，面板才知道需要参考音频
  assert.equal(bindingSummary(bindings).audioInputs, 1);
});

test("上传的参考音频会写回 LoadAudio，而不是保留写死的占位文件名", () => {
  const workflow = readWorkflow("audio-qwen3-tts-voice-clone");
  const bindings = detectFreeBindings(workflow);
  const next = applyFreeInputs(workflow, bindings, {
    prompt: "你好世界",
    uploadedAudios: [{ name: "reference_clone_00001_.flac", subfolder: "" }],
  });
  assert.equal(next["6"].inputs.audio, "reference_clone_00001_.flac", "必须写入上传后的真实文件名");
  assert.notEqual(next["6"].inputs.audio, workflow["6"].inputs.audio);
});

test("带 subfolder 的上传结果写成 子目录/文件名", () => {
  const workflow = readWorkflow("audio-qwen3-tts-voice-clone");
  const bindings = detectFreeBindings(workflow);
  const next = applyFreeInputs(workflow, bindings, { uploadedAudios: [{ name: "a.flac", subfolder: "audio" }] });
  assert.equal(next["6"].inputs.audio, "audio/a.flac");
});

test("没上传参考音频时不动原值，交给 ComfyUI 报缺失", () => {
  const workflow = readWorkflow("audio-qwen3-tts-voice-clone");
  const bindings = detectFreeBindings(workflow);
  const next = applyFreeInputs(workflow, bindings, { prompt: "你好" });
  assert.equal(next["6"].inputs.audio, workflow["6"].inputs.audio);
});

test("不需要参考音频的音频工作流 audios 为空", () => {
  for (const name of ["audio-qwen3-tts-voice-design", "audio-minimax-music3"]) {
    const bindings = detectFreeBindings(readWorkflow(name));
    assert.equal(bindings.outputType, "audio", `${name} 应识别为 audio`);
    assert.equal(bindings.audios.length, 0, `${name} 不该有参考音频输入`);
  }
});

test("参考音频不会混进图片输入", () => {
  const bindings = detectFreeBindings(readWorkflow("audio-qwen3-tts-voice-clone"));
  assert.equal(bindings.images.length, 0);
});

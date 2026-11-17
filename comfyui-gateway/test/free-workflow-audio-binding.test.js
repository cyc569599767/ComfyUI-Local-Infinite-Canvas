import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyFreeInputs } from "../src/free-workflows.js";
import { bindingSummary, convertUiWorkflow, detectFreeBindings } from "../src/ui-workflow.js";

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

test("Pika 长音频工作流把 Star7 同时接到 guider 和 scheduler，保留原注意力补丁", () => {
  const workflow = readWorkflow("video-pika_api");
  const chunk = Object.entries(workflow).find(([, node]) => node.class_type === "MiniMaxH3ActivationChunkStar7");
  assert.ok(chunk, "缺少实际的 Star7 显存分块节点");
  const [id, node] = chunk;
  assert.deepEqual(node.inputs.model, ["197", 0]);
  assert.deepEqual(workflow["124"].inputs.model, [id, 0]);
  assert.deepEqual(workflow["126"].inputs.model, [id, 0]);
  assert.equal(node.inputs.chunk_tokens, 4096);
  assert.equal(node.inputs.mlp_chunk_tokens, 2048);
  assert.equal(node.inputs.auto_halve_on_oom, true);
  assert.equal(node.inputs.attention_backend, "existing");
  assert.equal(workflow["124"].inputs.steps, 8);
  assert.equal(workflow["202"].inputs.strength_model, 0.75);
});

test("Pika 长音频默认不裁到14秒，时长、参考、锁定与合成使用同一音频", () => {
  const workflow = readWorkflow("video-pika_api");
  assert.deepEqual(workflow["136"].inputs["ref_audios.ref_audio_0"], ["171", 0]);
  assert.deepEqual(workflow["172"].inputs.source_audio, ["171", 0]);
  assert.deepEqual(workflow["179"].inputs.audio, ["171", 0]);
  assert.deepEqual(workflow["132"].inputs.value, ["179", 0]);
  assert.deepEqual(workflow["131"].inputs["values.a"], ["132", 0]);
  assert.deepEqual(workflow["136"].inputs.length, ["131", 1]);
  assert.match(workflow["131"].inputs.expression, /ceil\(a \* 24\)/);
  assert.deepEqual(workflow["142"].inputs.audio, ["172", 1]);
  assert.equal(workflow["142"].inputs.frame_rate, 24);
  assert.equal(workflow["142"].inputs.trim_to_audio, true);
  assert.ok(!Object.values(workflow).some((node) => node.class_type === "AudioCrop"));
});

test("Pika 接入分块后仍能经自由卡片正确写回上传音频与采样种子", () => {
  const workflow = readWorkflow("video-pika_api");
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "video");
  assert.equal(bindings.audios.length, 1);
  const next = applyFreeInputs(workflow, bindings, { uploadedAudios: [{ name: "long-reference.wav", subfolder: "audio" }], seed: "456", seedFixed: true });
  assert.equal(next["171"].inputs.audio, "audio/long-reference.wav");
  assert.equal(next["129"].inputs.noise_seed, 456);
  assert.equal(next["204"].class_type, "MiniMaxH3ActivationChunkStar7");
});

test("Pika UI 转换保留 Star7 的真实参数顺序和双 MODEL 消费者", () => {
  const api = readWorkflow("video-pika_api");
  // 来自已安装节点的 INPUT_TYPES 顺序，保留废弃兼容字符串，避免后续布尔/枚举错位。
  const info = {
    MiniMaxH3ActivationChunkStar7: {
      input: { required: {
        model: ["MODEL"],
        chunk_tokens: ["INT", { min: 256, max: 65536, step: 256 }],
        auto_halve_on_oom: ["BOOLEAN"],
        verbose: ["BOOLEAN"],
        mlp_chunk_tokens: ["INT", { min: 256, max: 65536, step: 256 }],
        disable_dynamic_prefetch: ["STRING"],
        reuse_mlp_weights: ["BOOLEAN"],
        attention_backend: [["existing", "comfy_kitchen_int8"]],
      } },
      output: ["MODEL"],
    },
  };
  const widgetNames = Object.keys(info.MiniMaxH3ActivationChunkStar7.input.required).filter((name) => name !== "model");
  const nodes = [197, 204, 124, 126].map((id) => {
    const original = api[String(id)];
    return {
      id, type: original.class_type, mode: 0, inputs: [], outputs: [{ type: "MODEL" }],
      widgets_values_named: Object.fromEntries(Object.entries(original.inputs).filter(([, value]) => !Array.isArray(value))),
    };
  });
  const ui = { nodes, links: [] };
  const connect = (id, from, to) => {
    ui.links.push([id, from, 0, to, 0, "MODEL"]);
    nodes.find((node) => node.id === to).inputs.push({ name: "model", type: "MODEL", link: id });
  };
  connect(1, 197, 204);
  connect(2, 204, 124);
  connect(3, 204, 126);
  const chunk = nodes.find((node) => node.id === 204);
  chunk.inputs.push(...widgetNames.map((name) => ({ name, type: info.MiniMaxH3ActivationChunkStar7.input.required[name][0], link: null, widget: { name } })));
  chunk.widgets_values = widgetNames.map((name) => api["204"].inputs[name]);
  for (const named of [true, false]) {
    if (!named) delete chunk.widgets_values_named;
    const converted = convertUiWorkflow(ui, info).workflow;
    assert.deepEqual(converted["204"].inputs, api["204"].inputs, named ? "按名读取控件" : "按顺序读取控件");
    assert.deepEqual(converted["124"].inputs.model, ["204", 0]);
    assert.deepEqual(converted["126"].inputs.model, ["204", 0]);
  }
});

test("Pika UI 的裁剪旁路可恢复，三个音频消费者始终共用同一音轨", () => {
  const ui = {
    nodes: [
      { id: 171, type: "LoadAudio", mode: 0, inputs: [], outputs: [{ type: "AUDIO" }], widgets_values_named: { audio: "long.wav" } },
      { id: 177, type: "AudioCrop", mode: 4, inputs: [{ name: "audio", type: "AUDIO", link: 1 }], outputs: [{ type: "AUDIO" }], widgets_values_named: { start_time: "0", end_time: "59" } },
      { id: 136, type: "MiniMaxH3ReferenceToVideo", inputs: [{ name: "ref_audios.ref_audio_0", type: "AUDIO", link: 2 }], outputs: [] },
      { id: 172, type: "VRGDG_MiniMaxH3AudioDrive", inputs: [{ name: "source_audio", type: "AUDIO", link: 3 }], outputs: [] },
      { id: 179, type: "SoundFlow_GetLength", inputs: [{ name: "audio", type: "AUDIO", link: 4 }], outputs: [] },
    ],
    links: [[1, 171, 0, 177, 0, "AUDIO"], [2, 177, 0, 136, 0, "AUDIO"], [3, 177, 0, 172, 0, "AUDIO"], [4, 177, 0, 179, 0, "AUDIO"]],
  };
  const info = {
    MiniMaxH3ReferenceToVideo: { input: { optional: { ref_audios: ["COMFY_AUTOGROW_V3", { template: { input: { required: { ref_audio: ["AUDIO"] } }, prefix: "ref_audio_", min: 0, max: 3 } }] } } },
  };
  const bypassed = convertUiWorkflow(ui, info).workflow;
  assert.equal(bypassed["177"], undefined);
  for (const [id, name] of [["136", "ref_audios.ref_audio_0"], ["172", "source_audio"], ["179", "audio"]]) {
    assert.deepEqual(bypassed[id].inputs[name], ["171", 0]);
  }
  ui.nodes.find((node) => node.id === 177).mode = 0;
  const cropped = convertUiWorkflow(ui, info).workflow;
  assert.equal(cropped["177"].inputs.end_time, "59");
  for (const [id, name] of [["136", "ref_audios.ref_audio_0"], ["172", "source_audio"], ["179", "audio"]]) {
    assert.deepEqual(cropped[id].inputs[name], ["177", 0]);
  }
});

// 视频工作流同样可能吃音频：数字人、音频驱动要靠一段驱动音频决定口型和台词。
// 曾经的 bug：/v1/free-workflows/:id/videos 只收 images，audios 字段被直接丢掉，
// applyFreeInputs 拿不到音频，LoadAudio 仍指向工作流里写死的文件名，
// ComfyUI 报 "Invalid audio file: <hash>.MP3"。
test("视频工作流的驱动音频能被扫描到，并在上传后写回", () => {
  const workflow = readWorkflow("video-pika_api");
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "video");
  assert.ok(Array.isArray(bindings.audios) && bindings.audios.length > 0, "视频工作流应带 audios 绑定");

  const target = bindings.audios[0];
  const next = applyFreeInputs(workflow, bindings, {
    uploadedAudios: [{ name: "drive_00001_.wav", subfolder: "audio" }],
  });
  assert.equal(
    next[target.node].inputs[target.input],
    "audio/drive_00001_.wav",
    "上传的驱动音频应写进 LoadAudio，而不是留着工作流里的旧文件名",
  );
});

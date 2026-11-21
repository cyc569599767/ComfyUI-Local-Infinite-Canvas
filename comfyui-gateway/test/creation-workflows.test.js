import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { applyBindings, BindingError, buildContext } from "../src/bindings.js";
import { CREATION_WORKFLOWS, pruneToOutputs, prepareCreationTemplate } from "../src/creation-workflows.js";
import { h3EasyReferences, h3EasyUploadFiles } from "../src/h3-easy-media.js";
import { createRegistry, isApiWorkflow } from "../src/registry.js";
import { createSetupManager } from "../src/setup.js";
import { MODEL_LOADER_SPECS } from "../src/model-loaders.js";
import { applyModelAliases, runWorkflow } from "../src/runner.js";
import { workflowAvailabilityProblem } from "../src/workflow-availability.js";

const dir = path.resolve(import.meta.dirname, "../workflows");
const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
const rows = read("registry.json").workflows;
const entries = CREATION_WORKFLOWS.map((descriptor) => ({ ...rows.find((row) => row.id === descriptor.id), workflow: read(descriptor.file) }));
const get = (id) => entries.find((entry) => entry.id === id);
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fingerprints = [
  "5cc56cfa406aed925f30f43ee94e72613a8fe18a50ac5eec1519c75486d12cb1",
  "ad57206110588c732f44dd83fe87c1b1253ea15bb4cf46f81f085daa078d2dd1",
  "23e2990a11f06c8c30089e4ba99a8054b9e7800e638fcf4b48240864fd5f4db7",
  "0c3008472a40492db06b88f6e7a15b05ca65c6fdf13f28ae230de0932c56b9fe",
  "10747ce0b0c8b53e65e282fb7ebfeb356402f47973e37c078076e2bd57f7a9d0",
  "3cc6281458eaf5544343db24deb22b57c87845b3050fba57e32e07b63f248914",
  "6d57975fbb06da99ceb506ee56f53d3f313c12536fedb8075680dbc2bba2d0c4",
];
const uploaded = (name) => ({ name, subfolder: "creation/uploads" });
const bind = (id, options = {}) => {
  const entry = get(id);
  return applyBindings(entry.workflow, entry, buildContext({ prompt: "测试提示词", ...options }));
};

for (const [index, entry] of entries.entries()) {
  test(`${entry.id}：完整 API 模板、精确注册与输出可达`, () => {
    const { workflow, ...descriptor } = entry;
    assert.deepEqual(descriptor, CREATION_WORKFLOWS[index]);
    assert.equal(rows.filter((row) => row.id === entry.id).length, 1);
    assert.equal(isApiWorkflow(workflow), true);
    assert.equal(digest(JSON.stringify(workflow)), fingerprints[index]);
    assert.deepEqual(pruneToOutputs(workflow, entry.outputNodes), workflow);
    for (const binding of Object.values(entry.bindings)) {
      assert.ok(workflow[binding.node]);
      if (!binding.h3EasyMedia) assert.ok(binding.input in workflow[binding.node].inputs);
    }
    for (const node of Object.values(workflow)) {
      if (["LoadImage", "LoadAudio", "LoadVideo"].includes(node.class_type)) {
        assert.ok(Object.values(node.inputs).every((value) => value === ""));
      }
      assert.equal(node.inputs.prompt_optimizer_resources, undefined);
    }
  });
}

test("既有注册项和工作流内容保持原样", () => {
  // 摘要覆盖除创作专用外的全部注册项；v0.25.3 选择性合并新增了
  // video-hyperflow-ref2va-6p2 / image-h3image / image-ph3image / video-h3-viggle-swap 四条，
  // 其余历史条目必须继续与基线逐字节一致。
  // 2026-11-21：为 video-h3-character-swap / video-h3-viggle-swap 增加 strictMedia 标记
  // （超限拒绝而非静默截断），注册表摘要据此更新；工作流 JSON 未改动，第二个摘要不变。
  const legacy = rows.filter((entry) => !entry.id.startsWith("creation-"));
  assert.equal(digest(JSON.stringify(legacy)), "2a7677025d5a2a97f9bfa0a324fc8f4c0414b6623a6a96cf52019206982c1c91");
  const files = [...new Set(legacy.flatMap((entry) => [entry.file, ...Object.values(entry.variants || {}).map((variant) => variant.file)]).filter(Boolean))].sort();
  // 规范化换行，避免 Windows Git autocrlf 造成无意义差异。
  const canonical = files.map((file) => [file, digest(JSON.stringify(read(file)))]);
  assert.equal(digest(JSON.stringify(canonical)), "9d4a168d77a1a73465e23233f124910669c87c6e294edbbce8bb5dae93f4cf97");
  for (const file of files) assert.equal(fs.existsSync(path.join(dir, file)), true);
});

test("Krea2 保留写实 LoRA、8步采样并绑定尺寸和种子", () => {
  const result = bind("creation-image-krea2", { size: "1536x864", count: 2, params: { seed: 0, steps: 1, unet: "other.safetensors" } });
  assert.equal(result["102"].inputs.text, "测试提示词");
  assert.deepEqual(result["100"].inputs, { width: 1536, height: 864, batch_size: 2 });
  assert.equal(result["96"].inputs.seed, 0);
  assert.equal(result["96"].inputs.steps, 8);
  assert.equal(result["98"].inputs.unet_name, "krea2_turbo_fp8.safetensors");
  assert.equal(result["101"].inputs.lora_name, "realism_engine_krea2_v3.1.safetensors");
});

test("Qwen 编辑必需上传参考图且保留 2511 采样链", () => {
  assert.throws(() => bind("creation-image-qwen-edit"), { code: "missing_reference_image" });
  const result = bind("creation-image-qwen-edit", { uploadedImages: [uploaded("ref.png")], params: { seed: 73 } });
  assert.equal(result["41"].inputs.image, "creation/uploads/ref.png");
  assert.equal(result["170:151"].inputs.prompt, "测试提示词");
  assert.equal(result["170:169"].inputs.seed, 73);
  assert.deepEqual(result["170:169"].inputs.steps, ["170:167", 0]);
});

for (const [id, node] of [["creation-video-h3-768", "2"], ["creation-video-h3-1080", "256"]]) {
  test(`${id}：9图3音3视频完整绑定、原生 VIDEO 及显式交错顺序`, () => {
    const uploadedImages = Array.from({ length: 9 }, (_, i) => uploaded(`${i}.png`));
    const uploadedAudios = Array.from({ length: 3 }, (_, i) => uploaded(`${i}.flac`));
    const uploadedVideos = Array.from({ length: 3 }, (_, i) => uploaded(`${i}.mp4`));
    const references = [
      ...uploadedAudios.map((_, index) => ({ type: "audio", index })),
      ...uploadedVideos.map((_, index) => ({ type: "video", index })),
      ...uploadedImages.map((_, index) => ({ type: "image", index })),
    ];
    const context = { uploadedImages, uploadedAudios, uploadedVideos, seconds: 8, params: { seed: 1234, aspect_ratio: "9:16", resolution: "360P", mode: "text", references } };
    const result = bind(id, context);
    const inputs = result[node].inputs;
    assert.equal(inputs.prompt, "测试提示词");
    assert.equal(inputs.resolution, id.endsWith("1080") ? "768P" : "360P");
    assert.equal(inputs.mode, "reference");
    assert.equal(inputs.seconds, 8);
    assert.equal(inputs.aspect_ratio, "9:16");
    references.forEach((ref, i) => {
      assert.equal(inputs[`media_type_${i + 1}`], ref.type);
      const load = result[inputs[`media_${i + 1}`][0]];
      const key = { image: "image", audio: "audio", video: "file" }[ref.type];
      const ext = { image: "png", audio: "flac", video: "mp4" }[ref.type];
      assert.equal(load.class_type, { image: "LoadImage", audio: "LoadAudio", video: "LoadVideo" }[ref.type]);
      assert.equal(load.inputs[key], `creation/uploads/${ref.index}.${ext}`);
    });
    assert.equal(Object.values(result).some((item) => /VHS_|GetVideoComponents/.test(item.class_type)), false);
    assert.deepEqual(pruneToOutputs(result, get(id).outputNodes), result);
    assert.equal(result[id.endsWith("768") ? "6" : "129"].inputs.noise_seed, 1234);
    if (id.endsWith("1080")) {
      assert.equal(result["210"].inputs["mode.scale"], 1.4);
      assert.equal(result["258"].class_type, "MiniMaxH3EasySecondPassConditioning");
      assert.deepEqual(result["212"].inputs.audio_latent, ["211", 1]);
      assert.deepEqual(result["220"].inputs.audio, ["218", 0]);
    } else {
      assert.equal(result["210"], undefined);
      assert.deepEqual(result["11"].inputs.audio, ["10", 0]);
    }
  });
}

test("普通 H3 暴露五档分辨率，未传值与导入模板默认保持 768P", () => {
  const entry = get("creation-video-h3-768");
  assert.deepEqual(entry.parameters.find((parameter) => parameter.key === "resolution"), {
    key: "resolution", label: "分辨率", type: "select", default: "768P", options: ["360P", "480P", "540P", "720P", "768P"],
  });
  assert.equal(get("creation-video-h3-1080").parameters.some((parameter) => parameter.key === "resolution"), false);
  const result = bind(entry.id, { uploadedImages: [uploaded("ref.png")] });
  assert.equal(result["2"].inputs.resolution, "768P");
  const source = structuredClone(entry.workflow);
  source["2"].inputs.resolution = "360P";
  const template = prepareCreationTemplate(source, entry);
  assert.deepEqual(template, entry.workflow);
  assert.deepEqual(prepareCreationTemplate(template, entry), template);
  assert.equal(source["2"].inputs.resolution, "360P");
});

for (const resolution of ["360P", "480P", "540P", "720P", "768P", "1080P"]) {
  test(`H3 ${resolution} 档位绑定、大小写归一与二次采样隔离`, () => {
    const upscale = resolution === "1080P";
    const id = upscale ? "creation-video-h3-1080" : "creation-video-h3-768";
    for (const value of [resolution, resolution.toLowerCase(), ` ${resolution.toLowerCase()} `]) {
      const graph = bind(id, { uploadedImages: [uploaded("ref.png")], params: { resolution: value, seed: 42, scale: 4, upscale: 4 } });
      assert.equal(graph[upscale ? "256" : "2"].inputs.resolution, upscale ? "768P" : resolution);
      if (upscale) {
        assert.equal(graph["210"].inputs["mode.scale"], 1.4);
        assert.equal(graph["258"].class_type, "MiniMaxH3EasySecondPassConditioning");
      } else {
        assert.equal(graph["210"], undefined);
      }
    }
    assert.equal(get(id).workflow[upscale ? "256" : "2"].inputs.resolution, "768P");
  });
}

test("普通 H3 拒绝 1080P 绕过及非法枚举值，不静默回退或提交", async () => {
  const entry = get("creation-video-h3-768");
  const uploadedImages = [uploaded("ref.png")];
  let submissions = 0;
  const comfy = { submit: async () => { submissions += 1; throw new Error("非法分辨率不得提交"); } };
  for (const resolution of ["1080P", "1080p", "2160P", "720", "custom", "", "   ", null, 360, false, {}, [], ["720P"]]) {
    const params = { resolution };
    assert.throws(() => bind(entry.id, { uploadedImages, params }), (error) => {
      assert.ok(error instanceof BindingError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_resolution");
      assert.match(error.message, /creation-video-h3-1080/);
      return true;
    });
    await assert.rejects(runWorkflow({ entry, context: buildContext({ prompt: "测试", uploadedImages, params }), comfy }), { code: "invalid_resolution" });
  }
  assert.equal(submissions, 0);
});

test("H3 媒体不截断、不去重，超额和错误顺序明确拒绝", () => {
  const id = "creation-video-h3-768";
  for (const [field, max] of [["uploadedImages", 9], ["uploadedAudios", 3], ["uploadedVideos", 3]]) {
    assert.throws(() => bind(id, { [field]: Array.from({ length: max + 1 }, () => uploaded("same")) }), { code: "too_many_reference_media" });
  }
  assert.throws(() => bind(id), { code: "missing_reference_media" });
  assert.throws(() => bind(id, { uploadedImages: [uploaded("1.png")], params: { references: [{ type: "image", index: 1 }] } }), { code: "invalid_reference_order" });
  assert.throws(() => bind(id, { uploadedImages: [uploaded("1.png")], params: { references: [] } }), { code: "invalid_reference_order" });
  const files = h3EasyUploadFiles(Array.from({ length: 9 }, () => ({ fieldname: "images", buffer: Buffer.from("same") })));
  assert.equal(files.uploadedImages.length, 9);
  assert.equal(h3EasyReferences(files, {}).length, 9);
});

test("清理模板旧媒体、优化器示例和输出不可达分支", () => {
  const entry = get("creation-video-h3-768");
  const dirty = structuredClone(entry.workflow);
  dirty["2"].inputs.media_1 = ["example", 0];
  dirty["2"].inputs.media_type_1 = "image";
  dirty["2"].inputs.prompt_optimizer_resources = "example.png";
  dirty.example = { class_type: "LoadImage", inputs: { image: "example.png" } };
  dirty.orphan = { class_type: "PreviewAudio", inputs: {} };
  const clean = prepareCreationTemplate(dirty, entry);
  assert.equal(clean.example, undefined);
  assert.equal(clean.orphan, undefined);
  const result = applyBindings(dirty, entry, buildContext({ prompt: "测试", uploadedAudios: [uploaded("voice.flac")] }));
  assert.equal(JSON.stringify(result).includes("example.png"), false);
  assert.equal(result.orphan, undefined);
});

test("音色设计、带 ASR 克隆和音乐参数准确绑定", () => {
  const design = bind("creation-audio-voice-design", { params: { voiceDescription: "清晰温和的成年嗓音", seed: 55 } });
  assert.equal(design["2"].inputs.text, "测试提示词");
  assert.equal(design["2"].inputs.voice_description, "清晰温和的成年嗓音");
  assert.equal(design["2"].inputs.seed, 55);
  assert.equal(design["4"], undefined);
  assert.throws(() => bind("creation-audio-voice-clone"), { code: "missing_reference_audio" });
  const clone = bind("creation-audio-voice-clone", { uploadedAudios: [uploaded("voice.flac")], params: { seed: 12 } });
  assert.equal(clone["42"].inputs.text, "测试提示词");
  assert.equal(clone["42"].inputs.seed, 12);
  assert.equal(clone["6"].inputs.audio, "creation/uploads/voice.flac");
  assert.equal(clone["42"].inputs.x_vector_only, false);
  assert.deepEqual(clone["42"].inputs.ref_text, ["40", 0]);
  assert.equal(clone["40"].class_type, "Qwen3TTSSenseVoiceASR");
  for (const lyrics of [undefined, "", "   ", null, "[Verse]\n测试歌词"]) {
    const music = bind("creation-audio-music", { params: { lyrics, maxDuration: 20, seed: 81 } });
    assert.equal(music["37:13"].inputs.caption, "测试提示词");
    assert.equal(music["37:13"].inputs.lyrics, lyrics?.trim() ? lyrics : " ");
    assert.equal(music["37:13"].inputs.max_duration, 20);
    assert.equal(music["37:38"].inputs.seed, 81);
    assert.deepEqual(music["37:9"].inputs.seed, ["37:38", 0]);
    assert.equal(music["37:9"].inputs.steps, 30);
  }
});

export function creationObjectInfo(workflows = entries) {
  const info = {};
  for (const entry of workflows) {
    for (const node of Object.values(entry.workflow)) {
      const required = (info[node.class_type] ??= { input: { required: {} } }).input.required;
      for (const spec of MODEL_LOADER_SPECS.filter((item) => item.classType === node.class_type)) {
        const value = node.inputs[spec.input];
        if (typeof value !== "string") continue;
        const options = (required[spec.input] ??= [[]])[0];
        if (!options.includes(value)) options.push(value);
      }
    }
  }
  for (const type of ["LoadImage", "LoadAudio", "LoadVideo"]) info[type] ??= { input: { required: {} } };
  return info;
}

async function setupFixture(t, workflows = entries, objectInfo = creationObjectInfo(workflows), mainModelFile = () => "") {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "creation-setup-"));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const manager = createSetupManager({
    config: { dataDir, comfyDir: "", comfyWorkflowsDir: "", maxWorkflowBytes: 5 * 1024 * 1024 },
    registry: { list: () => workflows, resolve: (id) => workflows.find((entry) => entry.id === id), scan: async () => ({}) },
    comfy: { systemStats: async () => ({}), objectInfo: async () => objectInfo }, mainModelFile,
  });
  await manager.scan();
  return manager;
}

test("精确模型可用，缺任意参考链节点不可用", async (t) => {
  const info = creationObjectInfo();
  const manager = await setupFixture(t, entries, info);
  for (const entry of entries) assert.equal(manager.isAvailable(entry.id), true, entry.id);
  for (const [id, nodeClass] of [["creation-video-h3-768", "MiniMaxH3Easy"], ["creation-video-h3-1080", "MiniMaxH3EasyLatentUpscaler3D"], ["creation-audio-voice-clone", "Qwen3TTSSenseVoiceASR"]]) {
    const saved = info[nodeClass];
    delete info[nodeClass];
    await manager.scan();
    assert.equal(manager.isAvailable(id), false);
    assert.equal(workflowAvailabilityProblem(manager, get(id)).code, "workflow_unavailable");
    info[nodeClass] = saved;
  }
});

test("strictModelNames 拒绝量化替代、手选别名和全局底模替代", async (t) => {
  const entry = get("creation-image-krea2");
  const info = creationObjectInfo([entry]);
  info.UNETLoader.input.required.unet_name = [["krea2_turbo_fp8_scaled.safetensors"]];
  const manager = await setupFixture(t, [entry], info, () => "krea2_turbo_fp8_scaled.safetensors");
  assert.equal(manager.isAvailable(entry.id), false);
  await manager.setModelAlias({ classType: "UNETLoader", input: "unet_name", from: "krea2_turbo_fp8.safetensors", to: "krea2_turbo_fp8_scaled.safetensors" });
  assert.equal(manager.isAvailable(entry.id), false);
  assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "krea2_turbo_fp8.safetensors", null, entry), "");
  assert.throws(() => applyModelAliases(entry.workflow, () => "different.safetensors", MODEL_LOADER_SPECS, entry), { code: "strict_model_mismatch" });
});

test("strictModelNames 仅允许精确路径或唯一 basename，歧义不猜", async (t) => {
  const entry = get("creation-image-krea2");
  const info = creationObjectInfo([entry]);
  const model = "krea2_turbo_fp8.safetensors";
  info.UNETLoader.input.required.unet_name = [[`模型\\${model}`]];
  const manager = await setupFixture(t, [entry], info);
  assert.equal(manager.isAvailable(entry.id), true);
  assert.equal(applyModelAliases(entry.workflow, manager.modelAliasFor, MODEL_LOADER_SPECS, entry)["98"].inputs.unet_name, `模型\\${model}`);
  info.UNETLoader.input.required.unet_name[0].push(`另一目录/${model}`);
  await manager.scan();
  assert.equal(manager.isAvailable(entry.id), false);
  info.UNETLoader.input.required.unet_name[0].push(model);
  await manager.scan();
  assert.equal(manager.isAvailable(entry.id), true);
});

test("registry 保持指定模型 ID，runner 保留原底模及 usedSeed", async () => {
  const registry = createRegistry({ dir, mainModelFile: () => "other.safetensors" });
  await registry.load();
  for (const entry of entries) {
    const resolved = registry.resolveModel(entry.id, { UNETLoader: ["other.safetensors"] }).entry;
    assert.equal(resolved.name, entry.id);
    assert.equal(resolved.mainModelFile, undefined);
  }
  const entry = get("creation-image-krea2");
  let submitted;
  const result = await runWorkflow({
    entry: { ...entry, mainModelFile: "other.safetensors" }, context: buildContext({ prompt: "测试", params: { seed: 77 } }),
    comfy: {
      submit: async (workflow) => { submitted = workflow; return { promptId: "test" }; },
      history: async () => ({ status: { completed: true }, outputs: { 95: { images: [{ filename: "test.png", type: "output" }] } } }),
      view: async () => ({ buffer: Buffer.from("测试输出"), mimeType: "image/png" }),
    },
  });
  assert.equal(submitted["98"].inputs.unet_name, "krea2_turbo_fp8.safetensors");
  assert.equal(result.usedSeed, 77);
});

test("桌面 seed 合并七个新 ID 与模板，不改已有用户记录", async (t) => {
  const require = createRequire(import.meta.url);
  const { seedWorkflows } = require("../../desktop/src/main/application.cjs");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "creation-seed-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fsp.mkdir(source);
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(source, "registry.json"), JSON.stringify({ version: 1, workflows: CREATION_WORKFLOWS }));
  for (const entry of entries) await fsp.copyFile(path.join(dir, entry.file), path.join(source, entry.file));
  const old = { id: "existing", label: "用户工作流" };
  await fsp.writeFile(path.join(target, "registry.json"), JSON.stringify({ version: 1, workflows: [old] }));
  seedWorkflows(source, target, path.join(root, "baseline.json"));
  const seeded = JSON.parse(await fsp.readFile(path.join(target, "registry.json"), "utf8"));
  assert.deepEqual(seeded.workflows[0], old);
  assert.deepEqual(seeded.workflows.slice(1), CREATION_WORKFLOWS);
  for (const entry of entries) assert.equal(fs.existsSync(path.join(target, entry.file)), true);
});

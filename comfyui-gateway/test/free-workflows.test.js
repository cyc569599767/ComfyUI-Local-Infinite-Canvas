import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyFreeInputs, createFreeWorkflowStore } from "../src/free-workflows.js";
import { convertUiWorkflow, detectFreeBindings } from "../src/ui-workflow.js";

const objectInfo = {
  CLIPLoader: { input: { required: { clip_name: [["clip.safetensors"], {}], type: [["stable_diffusion"], {}] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}], clip: ["CLIP", {}] } } },
  EmptyLatentImage: { input: { required: { width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] } } },
  KSampler: { input: { required: { model: ["MODEL", {}], seed: ["INT", {}], steps: ["INT", {}], cfg: ["FLOAT", {}], sampler_name: [["euler"], {}], scheduler: [["simple"], {}], positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], latent_image: ["LATENT", {}], denoise: ["FLOAT", {}] } } },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } } },
  SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } } },
  LoadImage: { input: { required: { image: [["input.png"], { image_upload: true }] } } },
  ImageScale: { input: { required: { image: ["IMAGE", {}], width: ["INT", {}], height: ["INT", {}] } } },
  ResolutionSelector: {
    input: {
      required: {
        aspect_ratio: ["COMBO", { options: ["1:1 (Square)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "4:3 (Standard)"] }],
        megapixels: ["FLOAT", {}],
        multiple: ["INT", {}],
      },
    },
  },
  VHS_VideoCombine: {
    input: {
      required: {
        images: ["IMAGE", {}],
        frame_rate: ["FLOAT", {}],
        loop_count: ["INT", {}],
        filename_prefix: ["STRING", {}],
        format: [["video/h264-mp4"], {}],
        pingpong: ["BOOLEAN", {}],
        save_output: ["BOOLEAN", {}],
      },
    },
  },
  TestCombo: {
    input: {
      required: {
        task_type: ["COMBO", { options: ["auto", "Ref2VA", "I2VA"] }],
        value: ["STRING", {}],
      },
    },
  },
  SaveVideo: {
    input: {
      required: {
        video: ["VIDEO", {}],
        filename_prefix: ["STRING", {}],
        format: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "auto" }] }],
      },
    },
  },
};

function uiNode(id, type, inputs, widgetsValuesNamed, mode = 0) {
  return {
    id,
    type,
    mode,
    inputs: inputs.map(([name, type, link]) => ({ name, type, link: link ?? null, ...(link == null ? { widget: { name } } : {}) })),
    outputs: type === "SaveImage" ? [] : [{ name: "OUT", type: "IMAGE" }],
    widgets_values_named: widgetsValuesNamed,
    widgets_values: Object.values(widgetsValuesNamed || {}),
  };
}

test("UI workflow conversion keeps widgets, links and resolves bypass", () => {
  const ui = {
    nodes: [
      uiNode(1, "LoadImage", [["image", "COMBO", null]], { image: "input.png" }),
      uiNode(2, "ImageScale", [["image", "IMAGE", 1], ["width", "INT", null], ["height", "INT", null]], { width: 512, height: 512 }, 4),
      uiNode(3, "SaveImage", [["images", "IMAGE", 2], ["filename_prefix", "STRING", null]], { filename_prefix: "out" }),
    ],
    links: [
      [1, 1, 0, 2, 0, "IMAGE"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["1"].inputs.image, "input.png");
  assert.deepEqual(result.workflow["3"].inputs.images, ["1", 0]);
  assert.equal(result.workflow["3"].inputs.filename_prefix, "out");
});

test("UI conversion resolves SetNode/GetNode virtual links", () => {
  const info = { ...objectInfo, CheckpointLoaderSimple: { input: { required: { ckpt_name: [["model.safetensors"], {}] } } } };
  const n = (id, type, inputs, outputs, widgets_values, title = "") => ({ id, type, title, mode: 0, inputs, outputs, widgets_values });
  const ui = {
    nodes: [
      n(1, "CheckpointLoaderSimple", [], [{ name: "MODEL", type: "MODEL" }, { name: "CLIP", type: "CLIP" }, { name: "VAE", type: "VAE" }], ["model.safetensors"]),
      n(2, "CLIPTextEncode", [{ name: "clip", type: "CLIP", link: 2 }], [{ name: "CONDITIONING", type: "CONDITIONING" }], ["positive text"]),
      n(3, "CLIPTextEncode", [{ name: "clip", type: "CLIP", link: 3 }], [{ name: "CONDITIONING", type: "CONDITIONING" }], ["negative text"]),
      n(4, "EmptyLatentImage", [], [{ name: "LATENT", type: "LATENT" }], [512, 512, 1]),
      n(5, "SetNode", [{ name: "CONDITIONING", type: "CONDITIONING", link: 5 }], [{ name: "CONDITIONING", type: "CONDITIONING", links: null }], ["positive_cond"], "Set_positive_cond"),
      n(6, "GetNode", [], [{ name: "CONDITIONING", type: "CONDITIONING", links: [8] }], ["positive_cond"], "Get_positive_cond"),
      n(7, "KSampler", [
        { name: "model", type: "MODEL", link: 1 },
        { name: "positive", type: "CONDITIONING", link: 8 },
        { name: "negative", type: "CONDITIONING", link: 6 },
        { name: "latent_image", type: "LATENT", link: 7 },
      ], [{ name: "LATENT", type: "LATENT" }], [12345, "fixed", 20, 7, "euler", "normal", 1]),
      n(8, "VAEDecode", [{ name: "samples", type: "LATENT", link: 9 }, { name: "vae", type: "VAE", link: 4 }], [{ name: "IMAGE", type: "IMAGE" }], []),
      n(9, "SaveImage", [{ name: "images", type: "IMAGE", link: 10 }], [], ["ComfyUI"]),
    ],
    links: [
      [1, 1, 0, 7, 0, "MODEL"],
      [2, 1, 1, 2, 0, "CLIP"],
      [3, 1, 1, 3, 0, "CLIP"],
      [4, 1, 2, 8, 1, "VAE"],
      [5, 2, 0, 5, 0, "CONDITIONING"],
      [6, 3, 0, 7, 2, "CONDITIONING"],
      [7, 4, 0, 7, 3, "LATENT"],
      [8, 6, 0, 7, 1, "CONDITIONING"],
      [9, 7, 0, 8, 0, "LATENT"],
      [10, 8, 0, 9, 0, "IMAGE"],
    ],
  };
  const result = convertUiWorkflow(ui, info);
  assert.deepEqual(result.workflow["7"].inputs.positive, ["2", 0]);
  assert.equal(Object.values(result.workflow).some((node) => /SetNode|GetNode/.test(node.class_type)), false);
  const bindings = detectFreeBindings(result.workflow, info);
  assert.equal(bindings.prompt?.node, "2");
  assert.deepEqual(bindings.textInputs.map((item) => item.role), ["positive", "negative"]);
});

test("UI conversion keeps importing when a used GetNode has no matching SetNode", () => {
  const info = { ...objectInfo, CheckpointLoaderSimple: { input: { required: { ckpt_name: [["model.safetensors"], {}] } } } };
  const ui = {
    nodes: [
      { id: 1, type: "GetNode", mode: 0, inputs: [], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [1] }], widgets_values: ["missing_cond"] },
      { id: 2, type: "KSampler", mode: 0, inputs: [{ name: "positive", type: "CONDITIONING", link: 1 }], outputs: [{ name: "LATENT", type: "LATENT" }], widgets_values: [1, "fixed", 20, 7, "euler", "normal", 1] },
    ],
    links: [[1, 1, 0, 2, 0, "CONDITIONING"]],
  };
  const result = convertUiWorkflow(ui, info);
  assert.equal(result.workflow["2"].inputs.positive, undefined);
  assert.equal(result.warnings.some((line) => /GetNode/.test(line)), false);
});

test("UI conversion ignores an unused GetNode without a SetNode", () => {
  const ui = {
    nodes: [
      { id: 1, type: "CLIPTextEncode", mode: 0, inputs: [], outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }], widgets_values: ["hello"] },
      { id: 2, type: "GetNode", mode: 0, inputs: [], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: null }], widgets_values: ["unused"] },
    ],
    links: [],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.deepEqual(Object.keys(result.workflow), ["1"]);
});

test("UI conversion keeps importing duplicate SetNodes with a deterministic first match", () => {
  const ui = {
    nodes: [
      { id: 1, type: "PrimitiveNode", mode: 0, inputs: [], outputs: [{ name: "STRING", type: "STRING" }], widgets_values: ["first"] },
      { id: 2, type: "PrimitiveNode", mode: 0, inputs: [], outputs: [{ name: "STRING", type: "STRING" }], widgets_values: ["second"] },
      { id: 3, type: "SetNode", mode: 0, inputs: [{ name: "STRING", type: "STRING", link: 1 }], outputs: [{ name: "STRING", type: "STRING", links: null }], widgets_values: ["dup"] },
      { id: 4, type: "SetNode", mode: 0, inputs: [{ name: "STRING", type: "STRING", link: 2 }], outputs: [{ name: "STRING", type: "STRING", links: null }], widgets_values: ["dup"] },
      { id: 5, type: "GetNode", mode: 0, inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [3] }], widgets_values: ["dup"] },
      { id: 6, type: "CLIPTextEncode", mode: 0, inputs: [{ name: "text", type: "STRING", link: 3 }], outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }], widgets_values: [""] },
    ],
    links: [
      [1, 1, 0, 3, 0, "STRING"],
      [2, 2, 0, 4, 0, "STRING"],
      [3, 5, 0, 6, 0, "STRING"],
    ],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["6"].inputs.text, "first");
  assert.equal(result.warnings.some((line) => /SetNode/.test(line)), false);
});

test("UI conversion keeps unknown nodes as best-effort API graph entries", () => {
  const ui = {
    nodes: [
      { id: 1, type: "TotallyUnknownNode", mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }], widgets_values_named: { value: 42 } },
      { id: 2, type: "SaveImage", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [], widgets_values: ["ComfyUI"] },
    ],
    links: [[1, 1, 0, 2, 0, "IMAGE"]],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["1"].class_type, "TotallyUnknownNode");
  assert.equal(result.workflow["1"].inputs.value, 42);
  assert.deepEqual(result.workflow["2"].inputs.images, ["1", 0]);
  assert.equal(result.warnings.some((line) => /TotallyUnknownNode/.test(line)), false);
});

test("UI conversion maps VHS widgets and normalizes display labels", () => {
  const ui = {
    nodes: [
      {
        id: 1,
        type: "VHS_VideoCombine",
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: null }],
        widgets_values: [24, 0, "video/out", "video/h264-mp4", false, true],
      },
      {
        id: 2,
        type: "TestCombo",
        mode: 0,
        inputs: [
          { name: "task_type", type: "COMBO", link: null, widget: { name: "task_type" } },
          { name: "value", type: "STRING", link: null, widget: { name: "value" } },
        ],
        widgets_values_named: { task_type: "Ref2VA — 参考生音视频", value: "x" },
      },
      {
        id: 3,
        type: "SaveVideo",
        mode: 0,
        inputs: [{ name: "video", type: "VIDEO", link: null }],
        widgets_values: ["video/out", "auto"],
      },
    ],
    links: [],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["1"].inputs.frame_rate, 24);
  assert.equal(result.workflow["1"].inputs.loop_count, 0);
  assert.equal(result.workflow["1"].inputs.filename_prefix, "video/out");
  assert.equal(result.workflow["1"].inputs.format, "video/h264-mp4");
  assert.equal(result.workflow["1"].inputs.pingpong, false);
  assert.equal(result.workflow["1"].inputs.save_output, true);
  assert.equal(result.workflow["2"].inputs.task_type, "Ref2VA");
  assert.equal(result.workflow["3"].inputs.filename_prefix, "video/out");
  assert.equal(result.workflow["3"].inputs.format, "auto");
});

test("binding detection finds prompt, size, batch, seed, image and output type", () => {
  const workflow = {
    1: { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["9", 0] } },
    2: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 768, batch_size: 2 } },
    3: { class_type: "KSampler", inputs: { model: ["8", 0], seed: 42, steps: 10, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["1", 0], negative: ["1", 0], latent_image: ["2", 0], denoise: 1 } },
    4: { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["8", 1] } },
    5: { class_type: "LoadImage", inputs: { image: "input.png" } },
    6: { class_type: "ImageScale", inputs: { image: ["5", 0], width: 512, height: 512 } },
    7: { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "out" } },
    10: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "ref" } },
  };
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "image");
  assert.deepEqual(bindings.prompt, { node: "1", input: "text" });
  assert.equal(bindings.images.length, 1);
  assert.equal(bindings.images[0].node, "5");
  assert.equal(bindings.sizes[0].node, "2");
  assert.equal(bindings.batches[0].default, 2);
  assert.equal(bindings.seeds[0].default, 42);
});

test("binding detection exposes every text input and prefers the positive primitive", () => {
  const info = {
    ...objectInfo,
    PrimitiveStringMultiline: { input: { required: { value: ["STRING", { multiline: true }] } } },
  };
  const workflow = {
    10: { class_type: "PrimitiveStringMultiline", inputs: { value: "positive text" }, _meta: { title: "提示词" } },
    11: { class_type: "CLIPTextEncode", inputs: { text: ["10", 0], clip: ["20", 0] } },
    12: { class_type: "CLIPTextEncode", inputs: { text: "negative text", clip: ["20", 0] }, _meta: { title: "负面提示词" } },
    13: { class_type: "KSampler", inputs: { seed: 1, model: ["20", 0], positive: ["11", 0], negative: ["12", 0] } },
    14: { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: "out" } },
    20: { class_type: "UNETLoader", inputs: { unet_name: "safe.safetensors" } },
  };
  const bindings = detectFreeBindings(workflow, info);
  assert.deepEqual(bindings.prompt, { node: "10", input: "value" });
  assert.deepEqual(bindings.textInputs.map((item) => [item.node, item.input, item.label, item.role]), [
    ["10", "value", "提示词", "positive"],
    ["12", "text", "负面提示词", "negative"],
  ]);
  const patched = applyFreeInputs(workflow, bindings, {
    prompt: "new positive",
    texts: [
      { node: "10", input: "value", value: "new positive" },
      { node: "12", input: "text", value: "new negative" },
      { node: "20", input: "unet_name", value: "evil.safetensors" },
    ],
  });
  assert.equal(patched[10].inputs.value, "new positive");
  assert.equal(patched[12].inputs.text, "new negative");
  assert.equal(patched[20].inputs.unet_name, "safe.safetensors");
});

test("free inputs patch the workflow and randomize seed when not fixed", () => {
  const workflow = { 1: { class_type: "CLIPTextEncode", inputs: { text: "old" } }, 2: { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } }, 3: { class_type: "KSampler", inputs: { seed: 42 } } };
  const bindings = {
    prompt: { node: "1", input: "text" },
    images: [],
    sizes: [{ node: "2", widthInput: "width", heightInput: "height" }],
    batches: [{ node: "2", input: "batch_size" }],
    seeds: [{ node: "3", input: "seed" }],
  };
  const patched = applyFreeInputs(workflow, bindings, { prompt: "new", size: { width: 1024, height: 768 }, count: 3, seedFixed: false });
  assert.equal(patched[1].inputs.text, "new");
  assert.equal(patched[2].inputs.width, 1024);
  assert.equal(patched[2].inputs.batch_size, 3);
  assert.notEqual(patched[3].inputs.seed, 42);
  const fixed = applyFreeInputs(workflow, bindings, { prompt: "new", seed: "123", seedFixed: true });
  assert.equal(fixed[3].inputs.seed, 123);
});

test("resolution selector aspect ratio is detected and patched", () => {
  const workflow = {
    1: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 1, multiple: 32 } },
    2: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
  };
  const bindings = detectFreeBindings(workflow, objectInfo);
  assert.equal(bindings.ratios.length, 1);
  assert.equal(bindings.ratios[0].node, "1");
  assert.ok(bindings.ratios[0].ratios.includes("16:9"));
  assert.ok(bindings.ratios[0].ratios.includes("9:16"));
  const patched = applyFreeInputs(workflow, bindings, { ratio: "9:16" });
  assert.equal(patched[1].inputs.aspect_ratio, "9:16 (Portrait Widescreen)");
  const unchanged = applyFreeInputs(workflow, bindings, { ratio: "auto" });
  assert.equal(unchanged[1].inputs.aspect_ratio, "16:9 (Widescreen)");
});

test("free workflow sources follow live directory settings without breaking explicit directories", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "free-workflows-live-dir-"));
  try {
    const dataDir = path.join(root, "data");
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    await Promise.all([dataDir, firstDir, secondDir].map((dir) => fsp.mkdir(dir)));
    const workflow = JSON.stringify({ 1: { class_type: "SaveImage", inputs: {} } });
    await Promise.all([
      fsp.writeFile(path.join(firstDir, "first.json"), workflow),
      fsp.writeFile(path.join(secondDir, "second.json"), workflow),
    ]);

    const explicit = createFreeWorkflowStore({ dataDir, comfyWorkflowsDir: firstDir, comfy: {} });
    assert.deepEqual((await explicit.listSources()).map((source) => source.name), ["first"]);

    const config = { comfyWorkflowsDir: "" };
    const live = createFreeWorkflowStore({
      dataDir,
      comfyWorkflowsDir: config.comfyWorkflowsDir,
      getComfyWorkflowsDir: () => config.comfyWorkflowsDir,
      comfy: {},
    });
    assert.deepEqual(await live.listSources(), []);
    config.comfyWorkflowsDir = firstDir;
    assert.deepEqual((await live.listSources()).map((source) => source.name), ["first"]);
    config.comfyWorkflowsDir = secondDir;
    assert.deepEqual((await live.listSources()).map((source) => source.name), ["second"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("free workflow store deletes entries and persists", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-workflows-"));
  try {
    const entry = {
      id: "fc-delete",
      name: "Delete me",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: { 1: { class_type: "Test", inputs: {} } },
      bindings: { outputType: "image", prompt: null, images: [], sizes: [], ratios: [], batches: [], seeds: [] },
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));

    const first = createFreeWorkflowStore({ dataDir, comfy: {} });
    await first.load();
    assert.equal(first.get("fc-delete")?.name, "Delete me");
    assert.equal((await first.rename("fc-delete", "  Renamed   Card  "))?.name, "Renamed Card");
    await assert.rejects(() => first.rename("fc-delete", "   "), /名称不能为空/);
    assert.equal((await first.remove("fc-delete"))?.id, "fc-delete");
    assert.equal(first.get("fc-delete"), null);
    assert.equal(await first.remove("missing"), null);

    const second = createFreeWorkflowStore({ dataDir, comfy: {} });
    await second.load();
    assert.equal(second.get("fc-delete"), null);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("orphan nodes are pruned before submission so they cannot fail validation", () => {
  const workflow = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } },
    "99": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "missing.safetensors" } },
    "98": { class_type: "LoraLoader", inputs: { model: ["99", 0], lora_name: "missing.safetensors", strength_model: 1, strength_clip: 1 } },
  };
  const next = applyFreeInputs(workflow, {}, { prompt: "p" });
  assert.deepEqual(Object.keys(next).sort(), ["1", "2"]);
  assert.equal(next["99"], undefined);
  assert.equal(next["98"], undefined);

  const noOutputs = { "1": { class_type: "LoadImage", inputs: { image: "a.png" } } };
  assert.deepEqual(applyFreeInputs(noOutputs, {}, { prompt: "p" }), noOutputs);
});

test("a stray SaveImage chain is dropped in favour of the main output", () => {
  const workflow = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "KSampler", inputs: { model: ["3", 0], latent_image: ["4", 0], seed: 1 } },
    "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "main.safetensors" } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["2", 0], vae: ["3", 1] } },
    "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "main" } },
    "90": { class_type: "SaveImage", inputs: { images: ["91", 0], filename_prefix: "stray" } },
    "91": { class_type: "VAEDecode", inputs: { samples: ["92", 0], vae: ["93", 0] } },
    "92": { class_type: "KSampler", inputs: { model: ["93", 0], latent_image: ["94", 0], seed: 2 } },
    "93": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "missing.safetensors" } },
    "94": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  };
  const next = applyFreeInputs(workflow, {}, { prompt: "p" });
  assert.equal(next["6"]?.class_type, "SaveImage", "main output kept");
  assert.equal(next["90"], undefined, "stray save dropped");
  assert.equal(next["93"], undefined, "stray model loader dropped");
  assert.equal(next["1"], undefined, "unused LoadImage dropped");
  assert.equal(Object.keys(next).length, 5);
});

test("UI conversion skips frontend-only group control nodes", () => {
  const ui = {
    nodes: [
      uiNode(1, "SaveImage", [["images", "IMAGE", null], ["filename_prefix", "STRING", null]], { filename_prefix: "out" }),
      { id: 2, type: "BanZhang_IgnoreGroups", mode: 0, inputs: [], outputs: [], widgets_values: [] },
    ],
    links: [],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["2"], undefined);
  assert.equal(result.warnings.some((warning) => warning.includes("UI 辅助节点")), false);
});

// —— 自定义绑定：把某个节点的配置项固定到卡片上 ——
// 用户在工作流图上拖一个配置项到卡片，网关只允许写回「工作流里真实存在且未被连线」的输入。
// 这两条限制是安全边界：没有它们，前端等于能改写整张工作流。

function apiWorkflow() {
  return {
    "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "2": { class_type: "KSampler", inputs: { model: ["9", 0], seed: 42, steps: 20, cfg: 7.5, sampler_name: "euler", scheduler: "simple", positive: ["3", 0], negative: ["4", 0], latent_image: ["1", 0], denoise: 1 } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["9", 1] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "ugly", clip: ["9", 1] } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["2", 0], vae: ["9", 2] } },
    "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "out" } },
    "9": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  };
}

test("custom bindings write back numbers and strings with their original types", () => {
  const workflow = apiWorkflow();
  const bindings = {
    prompt: { node: "3", input: "text" },
    textInputs: [{ node: "3", input: "text" }],
    customBindings: [
      { node: "2", input: "steps", label: "steps" },
      { node: "2", input: "sampler_name", label: "sampler" },
    ],
  };
  // 前端传上来的数字是字符串，写回时必须还原成数字，否则 ComfyUI 校验会失败。
  const next = applyFreeInputs(workflow, bindings, {
    prompt: "a dog",
    values: [
      { node: "2", input: "steps", value: "8" },
      { node: "2", input: "sampler_name", value: "dpmpp_2m" },
    ],
  });
  assert.equal(next["2"].inputs.steps, 8);
  assert.equal(typeof next["2"].inputs.steps, "number");
  assert.equal(next["2"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(next["3"].inputs.text, "a dog");
});

test("inputs that are not registered as custom bindings are ignored", () => {
  const workflow = apiWorkflow();
  const bindings = { textInputs: [{ node: "3", input: "text" }], customBindings: [{ node: "2", input: "steps" }] };
  // cfg 没被固定：即使请求里带了值也不能写进去，否则前端能改任意输入。
  const next = applyFreeInputs(workflow, bindings, {
    prompt: "x",
    values: [
      { node: "2", input: "cfg", value: "1" },
      { node: "9", input: "ckpt_name", value: "evil.safetensors" },
    ],
  });
  assert.equal(next["2"].inputs.cfg, 7.5);
  assert.equal(next["9"].inputs.ckpt_name, "model.safetensors");
});

test("a linked input cannot be pinned: setCustomBindings drops it", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-custom-"));
  try {
    const entry = {
      id: "fc-pin",
      name: "Pin",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: apiWorkflow(),
      bindings: { outputType: "image", prompt: { node: "3", input: "text" }, textInputs: [{ node: "3", input: "text" }] },
      warnings: [],
      customBindings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
    const store = createFreeWorkflowStore({ dataDir, comfy: {} });
    await store.load();

    await assert.rejects(() => store.setCustomBindings("missing", []), /自由卡片不存在/);

    const updated = await store.setCustomBindings("fc-pin", [
      { node: "2", input: "steps", label: "步数" },
      // positive 在工作流里是 ["3", 0] 连线，值由上游决定，不能固定。
      { node: "2", input: "positive", label: "连线输入" },
      { node: "999", input: "steps", label: "不存在的节点" },
      { node: "2", input: "nope", label: "不存在的输入" },
      { node: "2", input: "steps", label: "重复项" },
    ]);
    const keys = updated.customBindings.map((item) => `${item.node}.${item.input}`);
    assert.deepEqual(keys, ["2.steps"]);
    assert.equal(updated.customBindings[0].label, "步数", "重复项不覆盖首次的 label");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("用户固定的配置项经 setCustomBindings 保存后，执行时真的会写进工作流", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-pin-e2e-"));
  try {
    const entry = {
      id: "fc-e2e",
      name: "PinE2E",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: apiWorkflow(),
      bindings: { outputType: "image", prompt: { node: "3", input: "text" }, textInputs: [{ node: "3", input: "text" }] },
      warnings: [],
      customBindings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
    const store = createFreeWorkflowStore({ dataDir, comfy: {} });
    await store.load();

    // 用户在画布上把「步数」固定到卡片，并填成 8。
    await store.setCustomBindings("fc-e2e", [{ node: "2", input: "steps", label: "步数" }]);

    // 关键：必须按 server.js 的真实调用方式走 executionBindings，
    // 不能拿 publicEntry 的结果冒充（它顶层带 customBindings，会掩盖断裂）。
    const entryAfter = store.get("fc-e2e");
    const applied = applyFreeInputs(entryAfter.workflow, store.executionBindings(entryAfter), {
      prompt: "a dog",
      values: [{ node: "2", input: "steps", value: "8" }],
    });
    // 修复前这条会失败：applyFreeInputs 读 bindings.customBindings，
    // 而 setCustomBindings 写的是 entry.customBindings，两个字段从未打通，
    // 于是用户填的 8 被静默丢弃，执行用的还是工作流里的 20。
    assert.equal(applied["2"].inputs.steps, 8, "固定的步数必须生效，否则用户改了配置等于没改");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("固定配置后再读摘要，配置项也要跟着回来（新拖一张卡片才不会是旧配置）", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-pin-sum-"));
  try {
    const entry = {
      id: "fc-sum",
      name: "Sum",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: apiWorkflow(),
      bindings: { outputType: "image", prompt: { node: "3", input: "text" }, textInputs: [{ node: "3", input: "text" }] },
      warnings: [],
      customBindings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
    const store = createFreeWorkflowStore({ dataDir, comfy: {} });
    await store.load();

    const before = await store.publicEntry(store.get("fc-sum"));
    await store.setCustomBindings("fc-sum", [{ node: "2", input: "steps", label: "步数", surface: "settings" }]);
    const after = await store.publicEntry(store.get("fc-sum"));

    // 固定项是「这张卡片的配置」的一部分。摘要里读不到它，从库里再拖一张卡片
    // 得到的 freeCard 快照就缺这一项，用户会以为配置没保存。
    assert.deepEqual(
      after.customBindings.map((item) => `${item.node}.${item.input}`),
      ["2.steps"],
      "摘要必须带上固定项",
    );
    assert.equal(before.customBindings.length, 0, "固定前的摘要应为空");
    assert.equal(after.customBindings[0].surface, "settings", "surface 要原样带回，否则控件会被挪到卡片上");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("describeWorkflowGraph lists bindable inputs and skips linked ones", async () => {
  const { describeWorkflowGraph } = await import("../src/ui-workflow.js");
  // objectInfo 里的 combo 必须带 options，前端才能给出下拉而不是自由输入。
  const info = {
    ...objectInfo,
    KSampler: { input: { required: { ...objectInfo.KSampler.input.required, sampler_name: ["COMBO", { options: ["euler", "dpmpp_2m"] }] } } },
  };
  const graph = describeWorkflowGraph(apiWorkflow(), info);
  const sampler = graph.nodes.find((node) => node.classType === "KSampler");
  assert.ok(sampler, "sampler node must be present");
  const names = sampler.inputs.map((input) => input.name);
  // 已连线的 model/positive/negative/latent_image 不应出现：它们的值由上游决定。
  assert.ok(!names.includes("positive"));
  assert.ok(!names.includes("latent_image"));
  assert.ok(names.includes("steps"));
  assert.equal(sampler.inputs.find((input) => input.name === "steps").kind, "number");
  assert.equal(sampler.inputs.find((input) => input.name === "sampler_name").kind, "combo");
  assert.equal(graph.nodes.find((node) => node.classType === "SaveImage").output, true);
});

test("surface defaults to card and round-trips through setCustomBindings and publicEntry", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-surface-"));
  try {
    const entry = {
      id: "fc-surface",
      name: "Surface",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: apiWorkflow(),
      bindings: { outputType: "image", prompt: { node: "3", input: "text" }, textInputs: [{ node: "3", input: "text" }] },
      warnings: [],
      customBindings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
    const store = createFreeWorkflowStore({ dataDir, comfy: {} });
    await store.load();

    const updated = await store.setCustomBindings("fc-surface", [
      { node: "2", input: "steps", label: "steps" },
      { node: "2", input: "cfg", label: "cfg", surface: "settings" },
      // 不认的 surface 落到 card，不能让整条绑定被丢掉。
      { node: "2", input: "sampler_name", label: "sampler", surface: "sideways" },
    ]);
    const byInput = Object.fromEntries(updated.customBindings.map((item) => [item.input, item.surface]));
    assert.equal(byInput.steps, "card", "missing surface defaults to card");
    assert.equal(byInput.cfg, "settings", "explicit settings is kept");
    assert.equal(byInput.sampler_name, "card", "unknown surface falls back to card");

    // publicEntry 是前端唯一读到的形态：漏掉 surface 会让用户选的设置刷新后跳回卡片。
    const pub = await store.publicEntry(store.get("fc-surface"));
    const pubByInput = Object.fromEntries(pub.customBindings.map((item) => [item.input, item.surface]));
    assert.equal(pubByInput.cfg, "settings");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("legacy bindings without surface still read back as card", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-legacy-surface-"));
  try {
    const entry = {
      id: "fc-legacy",
      name: "Legacy",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: apiWorkflow(),
      bindings: { outputType: "image", prompt: { node: "3", input: "text" }, textInputs: [{ node: "3", input: "text" }] },
      warnings: [],
      // 加 surface 之前存下来的数据。
      customBindings: [{ node: "2", input: "steps", label: "steps" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
    const store = createFreeWorkflowStore({ dataDir, comfy: {} });
    await store.load();
    const pub = await store.publicEntry(store.get("fc-legacy"));
    assert.equal(pub.customBindings[0].surface, "card");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

// ComfyUI 有两种 combo 写法，模型加载节点至今还是老格式。
// 只认新格式的话 vae_name / lora_name / clip_name 会退化成文本框，用户得手打文件名。
test("describeWorkflowGraph reads legacy combo specs where options sit in the first slot", async () => {
  const { describeWorkflowGraph } = await import("../src/ui-workflow.js");
  // 三个节点都接进同一条链：只有能从输出回溯到的节点才会出现在图里。
  const workflow = {
    "60": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "61": { class_type: "LoraLoader", inputs: { lora_name: "anime.safetensors", strength_model: 1, strength_clip: 1, vae: ["60", 0] } },
    "62": { class_type: "SaveImage", inputs: { images: ["61", 0], filename_prefix: "out" } },
  };
  const info = {
    // 老格式：options 直接是 spec[0]，第二项只放 tooltip。
    VAELoader: { input: { required: { vae_name: [["ae.safetensors", "ema_vae_fp16.safetensors"], { tooltip: "pick a vae" }] } } },
    LoraLoader: {
      input: {
        required: {
          lora_name: [["anime.safetensors", "realistic.safetensors"]],
          strength_model: ["FLOAT", {}],
          strength_clip: ["FLOAT", {}],
        },
      },
    },
    SaveImage: { input: { required: { filename_prefix: ["STRING", {}] } } },
  };

  const graph = describeWorkflowGraph(workflow, info);
  const vae = graph.nodes.find((node) => node.classType === "VAELoader").inputs.find((input) => input.name === "vae_name");
  assert.equal(vae.kind, "combo", "legacy combo must not degrade to a text box");
  assert.deepEqual(vae.options, ["ae.safetensors", "ema_vae_fp16.safetensors"]);

  const lora = graph.nodes.find((node) => node.classType === "LoraLoader").inputs.find((input) => input.name === "lora_name");
  assert.equal(lora.kind, "combo");
  assert.deepEqual(lora.options, ["anime.safetensors", "realistic.safetensors"]);
});

test("a combo with no local files stays a dropdown instead of becoming a text box", async () => {
  const { describeWorkflowGraph } = await import("../src/ui-workflow.js");
  const workflow = {
    "70": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "" } },
    "71": { class_type: "SaveImage", inputs: { images: ["70", 0], filename_prefix: "out" } },
  };
  // 没装 checkpoint 时，ComfyUI 返回空选项列表。
  const info = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [[], { tooltip: "pick a checkpoint" }] } } } };
  const graph = describeWorkflowGraph(workflow, info);
  const ckpt = graph.nodes.find((node) => node.classType === "CheckpointLoaderSimple").inputs.find((input) => input.name === "ckpt_name");
  assert.equal(ckpt.kind, "combo", "an empty combo is still a combo");
  assert.deepEqual(ckpt.options, []);
});

// 「新增归档」= 复制成新条目，原条目不动。共用一条数据会让改一个动两个。
test("duplicate copies a free workflow without touching the original", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-dup-"));
  try {
    const entry = {
      id: "fc-orig",
      name: "Original",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: apiWorkflow(),
      bindings: { outputType: "image", prompt: { node: "3", input: "text" }, textInputs: [{ node: "3", input: "text" }] },
      warnings: [],
      customBindings: [{ node: "2", input: "steps", label: "steps", surface: "card" }],
      preset: { count: 2 },
      archivedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
    const store = createFreeWorkflowStore({ dataDir, comfy: {} });
    await store.load();

    const copy = await store.duplicate("fc-orig", { preset: { count: 3 } });
    assert.notEqual(copy.id, "fc-orig", "the copy gets its own id");
    assert.equal(copy.name, "Original 副本", "name is suffixed so the library has no duplicates");
    assert.equal(copy.preset.count, 3, "the given preset is used");
    assert.ok(copy.archivedAt, "the new archive is immediately archived");
    assert.deepEqual(copy.customBindings, entry.customBindings, "pinned settings carry over");

    // 原条目必须原封不动。
    const original = store.get("fc-orig");
    assert.equal(original.name, "Original");
    assert.equal(original.preset.count, 2);
    assert.ok(original.archivedAt, "the original keeps its archived state");

    // 深拷贝：改副本的工作流不能影响原条目。
    copy.workflow["2"].inputs.steps = 99;
    assert.notEqual(store.get("fc-orig").workflow["2"].inputs.steps, 99);

    // 再复制一次不能撞名。
    const copy2 = await store.duplicate("fc-orig");
    assert.equal(copy2.name, "Original 副本 2");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

async function duplicateFixture() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-dup-snapshot-"));
  const workflow = apiWorkflow();
  workflow["2"].inputs.enabled = true;
  const entry = {
    id: "fc-snapshot", name: "Snapshot", sourceRel: "test.json", sourceFormat: "api", sourceSignature: "123:456",
    workflow,
    bindings: {
      outputType: "image", prompt: { node: "3", input: "text" },
      textInputs: [{ node: "3", input: "text", default: "a cat" }, { node: "4", input: "text", default: "ugly" }],
    },
    customBindings: [
      { node: "2", input: "steps", label: "步数", surface: "settings" },
      { node: "3", input: "text", label: "提示词", surface: "card" },
      { node: "2", input: "cfg", label: "CFG", surface: "settings" },
      { node: "2", input: "enabled", label: "开关", surface: "settings" },
      { node: "2", input: "sampler_name", label: "采样器", surface: "settings" },
    ],
    preset: { size: "512x512", count: 2, seed: "42", seedFixed: "true" }, warnings: [],
    archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));
  const store = createFreeWorkflowStore({ dataDir, comfy: {} });
  await store.load();
  return { dataDir, store, entry };
}

test("自动文本取消固定可持久化，取消项不能经 values 改写工作流且可重新固定", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    const marked = await store.setCustomBindings(entry.id, [
      { node: "3", input: "text", label: "主文本", unpinned: true },
      { node: "2", input: "steps", label: "步数", surface: "settings" },
    ]);
    assert.equal((await store.publicEntry(marked)).customBindings[0].unpinned, true);
    const reloaded = createFreeWorkflowStore({ dataDir, comfy: {} });
    await reloaded.load();
    const saved = reloaded.get(entry.id);
    assert.equal(saved.customBindings[0].unpinned, true);
    const applied = applyFreeInputs(saved.workflow, reloaded.executionBindings(saved), {
      prompt: "prompt", texts: [{ node: "3", input: "text", value: "当前文本" }],
      values: [{ node: "3", input: "text", value: "旧值不能覆盖" }, { node: "2", input: "steps", value: 8 }],
    });
    assert.equal(applied["3"].inputs.text, "当前文本");
    assert.equal(applied["2"].inputs.steps, 8);
    const archived = await reloaded.setArchived(entry.id, true, undefined, { values: [{ node: "3", input: "text", value: "不得写入" }] });
    assert.equal(archived.workflow["3"].inputs.text, "a cat");
    const copy = await reloaded.duplicate(entry.id);
    assert.equal(copy.customBindings[0].unpinned, true);
    const restored = await reloaded.setCustomBindings(entry.id, [{ node: "3", input: "text", label: "重新固定" }]);
    assert.equal(restored.customBindings[0].unpinned, undefined);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("setArchived 保存当前文本和固定参数快照，重载后可执行且不修改原对象或源文件", async () => {
  const { dataDir, entry } = await duplicateFixture();
  try {
    const sourceFile = path.join(dataDir, entry.sourceRel);
    const source = JSON.stringify(entry.workflow);
    await fsp.writeFile(sourceFile, source);
    const store = createFreeWorkflowStore({
      dataDir,
      comfyWorkflowsDir: dataDir,
      comfy: { objectInfo: () => { throw new Error("归档不应访问 ComfyUI"); } },
    });
    await store.load();
    const original = store.get(entry.id);
    original.bindings = detectFreeBindings(original.workflow, objectInfo);
    const before = structuredClone(original);
    const preset = { size: "768x1024", aspectRatio: "3:4", count: 3, seed: "777", seedFixed: "true" };
    const snapshot = {
      texts: [{ node: "3", input: "text", value: "新的正向提示词" }, { node: "4", input: "text", value: "新的负向提示词" }],
      values: [
        { node: "2", input: "steps", value: "8" },
        { node: "2", input: "cfg", value: "4.25" },
        { node: "2", input: "enabled", value: false },
        { node: "2", input: "sampler_name", value: "dpmpp_2m" },
        { node: "3", input: "text", value: "固定提示词优先" },
      ],
    };
    const requestBefore = structuredClone(snapshot);
    const archived = await store.setArchived(entry.id, true, preset, snapshot);
    assert.equal(archived.workflow["3"].inputs.text, "固定提示词优先");
    assert.equal(archived.workflow["4"].inputs.text, "新的负向提示词");
    assert.equal(archived.workflow["2"].inputs.steps, 8);
    assert.equal(archived.workflow["2"].inputs.cfg, 4.25);
    assert.equal(archived.workflow["2"].inputs.enabled, false);
    assert.equal(archived.workflow["2"].inputs.sampler_name, "dpmpp_2m");
    assert.equal(archived.workflow["2"].inputs.seed, 42, "未明确快照的种子不能被预设或随机数重置");
    assert.deepEqual(archived.workflow["1"], before.workflow["1"], "不能把归档当作生成而重置尺寸或批量数");
    assert.deepEqual(archived.preset, preset);
    assert.deepEqual(archived.customBindings, before.customBindings);
    assert.equal(archived.id, entry.id);
    assert.equal(archived.createdAt, before.createdAt);
    assert.equal(archived.sourceSignature, before.sourceSignature);
    assert.ok(archived.archivedAt);
    assert.notEqual(archived.updatedAt, before.updatedAt);
    assert.equal(store.get(entry.id), archived);
    assert.notEqual(archived, original);
    assert.deepEqual(original, before, "候选快照不能原地修改旧条目");
    assert.deepEqual(snapshot, requestBefore, "不能修改调用方输入");
    assert.equal(await fsp.readFile(sourceFile, "utf8"), source);

    const reloaded = createFreeWorkflowStore({ dataDir, comfy: {} });
    await reloaded.load();
    const saved = reloaded.get(entry.id);
    assert.deepEqual(saved, archived);
    assert.deepEqual(saved.bindings.textInputs.map((item) => item.default), ["固定提示词优先", "新的负向提示词"]);
    const applied = applyFreeInputs(saved.workflow, reloaded.executionBindings(saved), {
      prompt: saved.workflow["3"].inputs.text,
      seed: "42", seedFixed: true,
    });
    assert.equal(applied["2"].inputs.steps, 8);
    assert.equal(applied["4"].inputs.text, "新的负向提示词");
    const overridden = applyFreeInputs(saved.workflow, reloaded.executionBindings(saved), {
      prompt: "执行提示词", values: [{ node: "2", input: "steps", value: "11" }],
    });
    assert.equal(overridden["2"].inputs.steps, 11, "执行必须合并真实 customBindings");
    assert.equal(saved.workflow["2"].inputs.steps, 8);

    await fsp.unlink(sourceFile);
    const updated = await store.setArchived(entry.id, true, undefined, { texts: [{ node: "4", input: "text", value: "" }] });
    assert.equal(updated.workflow["4"].inputs.text, "", "源文件缺失也能更新归档，空串表示明确清空");
    assert.equal(updated.archivedAt, archived.archivedAt, "更新已有归档不重置首次归档时间");
    assert.deepEqual(updated.preset, preset, "省略预设时保留已有预设");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("setArchived 忽略未登记、连线、缺失及类型无效的输入", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    const original = store.get(entry.id);
    original.customBindings.push({ node: "2", input: "positive" }, { node: "2", input: "missing" });
    original.bindings.textInputs.push({ node: "2", input: "negative" });
    const before = structuredClone(original);
    const archived = await store.setArchived(entry.id, true, undefined, {
      texts: [
        { node: "4", input: "text", value: "保留的合法文本" },
        { node: "4", input: "text", value: { invalid: true } },
        { node: "4", input: "text", value: NaN },
        { node: "9", input: "ckpt_name", value: "other.safetensors" },
        { node: "2", input: "negative", value: "不能覆盖连线" },
        null,
      ],
      values: [
        { node: "2", input: "steps", value: "9" },
        { node: "2", input: "steps", value: NaN },
        { node: "2", input: "steps", value: Infinity },
        { node: "2", input: "steps", value: [] },
        { node: "2", input: "cfg", value: "NaN" },
        { node: "2", input: "enabled", value: null },
        { node: "2", input: "positive", value: "不能覆盖连线" },
        { node: "2", input: "missing", value: 1 },
        { node: "999", input: "steps", value: 1 },
        { node: "9", input: "ckpt_name", value: "other.safetensors" },
        { node: "4", input: "text", value: "只登记为文本，不能从固定参数写入" },
        null,
      ],
    });
    const expected = structuredClone(before.workflow);
    expected["2"].inputs.steps = 9;
    expected["4"].inputs.text = "保留的合法文本";
    assert.deepEqual(archived.workflow, expected);
    assert.deepEqual(original, before);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("setArchived 拒绝无效数组且不更改已有归档、预设或持久化文件", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    const file = path.join(dataDir, "free-workflows.json");
    await assert.rejects(store.setArchived("missing", true), /自由卡片不存在/);
    for (const initial of [false, true]) {
      await store.setArchived(entry.id, initial);
      const original = store.get(entry.id);
      const before = structuredClone(original);
      const persisted = await fsp.readFile(file, "utf8");
      for (const archived of [true, false]) {
        for (const snapshot of [{ texts: null }, { texts: {} }, { texts: "[]" }, { values: null }, { values: {} }, { values: "bad" }]) {
          await assert.rejects(store.setArchived(entry.id, archived, { count: 9 }, snapshot), /配置值必须是数组/);
          assert.equal(store.get(entry.id), original);
          assert.deepEqual(original, before);
          assert.equal(await fsp.readFile(file, "utf8"), persisted);
        }
      }
    }
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("setArchived 保持旧调用兼容且取消归档不会覆盖工作流快照", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    const archived = await store.setArchived(entry.id, true);
    assert.ok(archived.archivedAt);
    assert.deepEqual(archived.workflow, entry.workflow);
    assert.deepEqual(archived.preset, entry.preset);
    const updated = await store.setArchived(entry.id, true, { count: 3 });
    assert.equal(updated.archivedAt, archived.archivedAt);
    assert.equal(updated.preset.count, 3);
    const unarchived = await store.setArchived(entry.id, false, undefined, {
      texts: [{ node: "3", input: "text", value: "不应写入" }],
      values: [{ node: "2", input: "steps", value: "99" }],
    });
    assert.equal(unarchived.archivedAt, null);
    assert.deepEqual(unarchived.workflow, entry.workflow);
    assert.deepEqual(unarchived.preset, updated.preset);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("setArchived 持久化失败回滚原条目，恢复后仍可保存", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  const file = path.join(dataDir, "free-workflows.json");
  const backup = path.join(dataDir, "original.json");
  try {
    await store.setArchived(entry.id, true);
    const original = store.get(entry.id);
    const before = structuredClone(original);
    const persisted = await fsp.readFile(file, "utf8");
    await fsp.rename(file, backup);
    await fsp.mkdir(file);
    for (const archived of [true, false]) {
      await assert.rejects(store.setArchived(entry.id, archived, { count: 9 }, {
        texts: [{ node: "3", input: "text", value: "未保存文本" }],
        values: [{ node: "2", input: "steps", value: "99" }],
      }));
      assert.equal(store.get(entry.id), original);
      assert.deepEqual(original, before);
      assert.equal(await fsp.readFile(backup, "utf8"), persisted);
    }
    await fsp.rmdir(file);
    await fsp.rename(backup, file);
    const saved = await store.setArchived(entry.id, true, undefined, { values: [{ node: "2", input: "steps", value: "8" }] });
    const reloaded = createFreeWorkflowStore({ dataDir, comfy: {} });
    await reloaded.load();
    assert.equal(saved.workflow["2"].inputs.steps, 8);
    assert.deepEqual(reloaded.get(entry.id), saved);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("duplicate snapshots current texts and pinned values, preserves the original and survives reload", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    const preset = { size: "768x1024", aspectRatio: "3:4", count: 3, seed: "777", seedFixed: "false" };
    const copy = await store.duplicate(entry.id, {
      preset,
      texts: [{ node: "3", input: "text", value: "a dog" }, { node: "4", input: "text", value: "bad lighting" }],
      values: [
        { node: "2", input: "steps", value: "8" },
        { node: "2", input: "cfg", value: "4.25" },
        { node: "2", input: "enabled", value: false },
        { node: "2", input: "sampler_name", value: "dpmpp_2m" },
        // 和生成请求一致：固定项优先，而且空文本就是明确清空。
        { node: "3", input: "text", value: "" },
      ],
    });
    assert.deepEqual(store.get(entry.id), entry, "source workflow, bindings, preset and timestamps stay untouched");
    assert.deepEqual(copy.preset, preset);
    assert.deepEqual(copy.customBindings, entry.customBindings, "labels, order and display surfaces carry over");
    assert.equal(copy.workflow["2"].inputs.steps, 8);
    assert.equal(copy.workflow["2"].inputs.cfg, 4.25);
    assert.equal(copy.workflow["2"].inputs.enabled, false);
    assert.equal(copy.workflow["2"].inputs.sampler_name, "dpmpp_2m");
    assert.equal(copy.workflow["3"].inputs.text, "");
    assert.equal(copy.workflow["4"].inputs.text, "bad lighting");
    assert.equal(copy.workflow["2"].inputs.seed, 42, "archiving is not a generation and must not randomize seed");
    assert.equal(copy.sourceSignature, entry.sourceSignature);

    const reloaded = createFreeWorkflowStore({ dataDir, comfy: {} });
    await reloaded.load();
    assert.deepEqual(reloaded.get(entry.id), entry);
    assert.deepEqual(reloaded.get(copy.id), JSON.parse(JSON.stringify(copy)));
    const summary = await reloaded.publicEntry(reloaded.get(copy.id));
    assert.equal(summary.archived, true);
    assert.deepEqual(summary.textInputs.map((item) => item.default), ["", "bad lighting"]);
    assert.deepEqual(summary.customBindings, entry.customBindings);
    assert.deepEqual((await reloaded.list({ archived: true })).map((item) => item.id), [copy.id]);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("duplicate ignores unregistered, stale linked, missing and malformed snapshot inputs", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    // 模拟同步后的旧绑定：即使仍登记着，也不能用标量覆盖连线或新增输入。
    store.get(entry.id).customBindings.push({ node: "2", input: "positive" }, { node: "2", input: "missing" });
    const original = structuredClone(store.get(entry.id));
    const copy = await store.duplicate(entry.id, {
      texts: [{ node: "9", input: "ckpt_name", value: "evil.safetensors" }, null],
      values: [
        { node: "9", input: "ckpt_name", value: "evil.safetensors" },
        { node: "2", input: "positive", value: "not a link" },
        { node: "2", input: "missing", value: 1 },
        { node: "999", input: "steps", value: 1 },
        { node: "2", input: "steps", value: { invalid: true } },
        { node: "2", input: "steps", value: Infinity },
        { node: "2", input: "cfg", value: "not a number" },
        { node: "2", input: "enabled", value: null },
        null,
      ],
    });
    assert.deepEqual(copy.workflow, original.workflow);
    assert.deepEqual(store.get(entry.id), original);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("duplicate rejects invalid requests without creating an archive", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    await assert.rejects(store.duplicate("missing"), /自由卡片不存在/);
    for (const preset of [null, [], "bad"]) await assert.rejects(store.duplicate(entry.id, { preset }), /参数预设格式不正确/);
    for (const args of [{ texts: {} }, { texts: null }, { values: "bad" }, { values: null }]) {
      await assert.rejects(store.duplicate(entry.id, args), /配置值必须是数组/);
    }
    assert.deepEqual((await store.list()).map((item) => item.id), [entry.id]);
    assert.deepEqual(store.get(entry.id), entry);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("duplicate inherits the preset by value when no override is supplied", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  try {
    const copy = await store.duplicate(entry.id);
    assert.deepEqual(copy.preset, entry.preset);
    copy.preset.count = 10;
    copy.customBindings[0].label = "changed";
    copy.bindings.textInputs[0].default = "changed";
    assert.deepEqual(store.get(entry.id), entry);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("duplicate reports persistence failure, removes the failed copy and can save again", async () => {
  const { dataDir, store, entry } = await duplicateFixture();
  const file = path.join(dataDir, "free-workflows.json");
  const backup = path.join(dataDir, "original.json");
  try {
    // 仅操作本测试创建的临时文件：用同名目录稳定触发写入失败，不依赖 chmod。
    await fsp.rename(file, backup);
    await fsp.mkdir(file);
    await assert.rejects(store.duplicate(entry.id));
    assert.deepEqual((await store.list()).map((item) => item.id), [entry.id]);
    assert.deepEqual(store.get(entry.id), entry);
    await fsp.rmdir(file);
    await fsp.rename(backup, file);

    const copy = await store.duplicate(entry.id);
    assert.equal(copy.name, "Snapshot 副本", "failed copies do not reserve a name");
    const reloaded = createFreeWorkflowStore({ dataDir, comfy: {} });
    await reloaded.load();
    assert.deepEqual((await reloaded.list()).map((item) => item.id).sort(), [entry.id, copy.id].sort());
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

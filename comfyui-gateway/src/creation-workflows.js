// 独立入口只使用指定的 NVIDIA 参考图，不借用或覆盖画布现有工作流。
const seed = (node, input = "seed") => ({ node, input, from: "params.seed", transform: "int", random: true });
const output = (node, id) => ({ node, input: "filename_prefix", from: "params.filenamePrefix", default: `creation/${id}` });
const seedParameter = { key: "seed", label: "种子", type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 };
const entry = (id, type, label, sourceFile, outputNode, bindings, extra = {}) => ({
  id, name: id, type, label, file: `${id}.json`,
  description: `无限创作专用：${sourceFile}；默认保留参考模型、LoRA、采样和音轨；可在添加工作流中显式配置模型，不自动使用相似权重。`,
  strictModelNames: true,
  outputNodes: [outputNode],
  source: { kind: "creation-reference", file: sourceFile, hardware: "nvidia" },
  bindings: { ...bindings, filenamePrefix: output(outputNode, id) },
  parameters: [seedParameter],
  ...extra,
});

function video(id, node, noise, outputNode, sourceFile, upscale) {
  return entry(id, "video", upscale ? "创作 H3 1080P 二次采样" : "创作 H3 360P–768P", sourceFile, outputNode, {
    prompt: { node, input: "prompt", required: true },
    seconds: { node, input: "seconds", from: "seconds", default: 5 },
    resolution: upscale
      ? { node, input: "resolution", value: "768P" }
      : { node, input: "resolution", from: "params.resolution", default: "768P", transform: "creationH3Resolution" },
    aspectRatio: { node, input: "aspect_ratio", from: "params.aspect_ratio", default: "16:9" },
    mode: { node, input: "mode", value: "reference" },
    seed: seed(noise, "noise_seed"),
    media: { node, input: "media", h3EasyMedia: true, maxImages: 9, maxAudios: 3, maxVideos: 3 },
    ...(upscale ? { upscale: { node: "210", input: "mode.scale", value: 1.4 } } : {}),
  }, {
    minMedia: 1,
    parameters: [
      seedParameter,
      { key: "aspect_ratio", label: "宽高比", type: "select", default: "16:9", options: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
      ...(!upscale ? [{ key: "resolution", label: "分辨率", type: "select", default: "768P", options: ["360P", "480P", "540P", "720P", "768P"] }] : []),
    ],
  });
}

export const CREATION_WORKFLOWS = [
  entry("creation-image-krea2", "image", "创作 Krea2 超写实", "krea2_hyperreal_2608.json", "95", {
    prompt: { node: "102", input: "text", required: true },
    width: { node: "100", input: "width", from: "size.width", transform: "int", default: 1920 },
    height: { node: "100", input: "height", from: "size.height", transform: "int", default: 1080 },
    batch: { node: "100", input: "batch_size", from: "count", default: 1 },
    seed: seed("96"),
  }),
  entry("creation-image-qwen-edit", "image", "创作 Qwen 2511 图像编辑", "image_qwen_image_edit_2511_i2i.json", "9", {
    prompt: { node: "170:151", input: "prompt", required: true },
    seed: seed("170:169"),
    image: { node: "41", input: "image", from: "image", imageIndex: 0, required: true },
  }),
  video("creation-video-h3-768", "2", "6", "12", "MiniMax_H3_Easy_r2v.json", false),
  video("creation-video-h3-1080", "256", "129", "272", "MiniMax_H3_Easy_hybrid_r2v_Sigma_Latent_Upscale.json", true),
  entry("creation-audio-voice-design", "audio", "创作 Qwen3 音色设计", "qwen3_tts_voice_design_ui.json", "3", {
    prompt: { node: "2", input: "text", required: true },
    voiceDescription: { node: "2", input: "voice_description", from: "params.voiceDescription", required: true },
    seed: seed("2"),
  }, { audioMode: "voice-design" }),
  entry("creation-audio-voice-clone", "audio", "创作 Qwen3 音色克隆", "Qwen3-TTS_Voice_Clone_Reference.json", "8", {
    prompt: { node: "42", input: "text", required: true },
    seed: seed("42"),
    audio: { node: "6", input: "audio", from: "audio", audioIndex: 0, required: true },
  }, { audioMode: "voice-clone" }),
  entry("creation-audio-music", "audio", "创作 MiniMax Music3", "audio_minimax_music_3.json", "35", {
    prompt: { node: "37:13", input: "caption", required: true },
    lyrics: { node: "37:13", input: "lyrics", from: "params.lyrics", default: " ", transform: "lyricsOrSpace" },
    maxDuration: { node: "37:13", input: "max_duration", from: "params.maxDuration", default: 60 },
    seed: seed("37:38"),
  }, { audioMode: "music" }),
];

// User-approved whole-profile switch; new ID isolates the old 2511 overrides.
export const CREATION_QWEN21_WORKFLOW = entry("creation-image-qwen21-edit", "image", "创作 Qwen 2.1 图像编辑", "image-qwen21v2-edit.json", "422", {
  prompt: { node: "430", input: "prompt", required: true },
  negative: { node: "430", input: "negative_prompt", default: "artifacts, low quality, blurry, deformed, watermark" },
  seed: seed("456", "noise_seed"),
  resolution: { node: "430", input: "resolution", value: 1024 },
  refs: { node: "430", input: "images", from: "image", array: true, inputPrefix: "images.image_", indexBase: 1, min: 1, max: 3 },
}, {
  source: { kind: "creation-reference", file: "image-qwen21v2-edit.json", hardware: "nvidia", profile: "qwen21", bundled: true },
  description: "用户选择的完整 Qwen 2.1 编辑链：2.1 Turbo、Qwen3VL 8B、2.1 VAE、一致性 LoRA 0.48、9步采样；独立ID，不沿用2511模型覆盖。",
});
export const ALL_CREATION_WORKFLOWS = [...CREATION_WORKFLOWS, CREATION_QWEN21_WORKFLOW];

// 从指定输出反向裁剪；不折叠采样器、开关、LoRA 或音轨分支。
export function pruneToOutputs(workflow, outputNodes) {
  const keep = new Set();
  const stack = [...outputNodes];
  while (stack.length) {
    const id = String(stack.pop());
    if (keep.has(id)) continue;
    if (!workflow[id]) throw new Error(`工作流引用不存在的节点 ${id}`);
    keep.add(id);
    for (const value of Object.values(workflow[id].inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) stack.push(value[0]);
    }
  }
  return Object.fromEntries(Object.entries(workflow).filter(([id]) => keep.has(id)));
}

export function prepareCreationTemplate(source, descriptor) {
  const workflow = structuredClone(source);
  for (const node of Object.values(workflow)) {
    if (node._meta?.title) node._meta.title = node._meta.title.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").trim();
  }
  for (const [key, binding] of Object.entries(descriptor.bindings)) {
    const inputs = workflow[binding.node].inputs;
    if (binding.array) {
      for (const input of Object.keys(inputs)) if (input.startsWith(binding.inputPrefix || binding.input)) delete inputs[input];
    } else if (binding.h3EasyMedia) {
      for (const input of Object.keys(inputs)) {
        if (input === "media" || /^media_(?:type_)?\d+$/.test(input) || /^prompt_optimizer_(resources|marker|prompt_connected)$/.test(input)) delete inputs[input];
      }
    } else if (binding.value !== undefined) inputs[binding.input] = binding.value;
    else if (binding.transform === "creationH3Resolution") inputs[binding.input] = binding.default;
    else if (["prompt", "voiceDescription", "image", "audio"].includes(key)) inputs[binding.input] = "";
    else if (key === "lyrics") inputs[binding.input] = " ";
  }
  return pruneToOutputs(workflow, descriptor.outputNodes);
}

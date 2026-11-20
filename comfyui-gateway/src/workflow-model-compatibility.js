// Deliberately narrow, evidence-based rejects. An unknown filename is NOT proof of
// compatibility; only known architecture conflicts are rejected here.
const basename = value => String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
const qwen21 = value => /qwen[-_ ]*(?:image[-_ ]*)?(?:2[._-]1|21)(?:[^0-9]|$)/i.test(basename(value));
const h3Encoder = value => /(?:minimax[-_ ]?h3|mmh3)/i.test(basename(value));
const qwen3Encoder = value => /qwen[-_ ]?3(?:[._-]?vl|[-_ ]+vl)/i.test(basename(value));

export function workflowModelCompatibilityProblem(entry, nodeId, input, value) {
  const graph = entry?.templateWorkflow || entry?.workflow || {};
  const classType = graph[nodeId]?.class_type;
  if (entry?.id === "creation-image-qwen21-edit" && Object.values(graph).some(node => node?.class_type === "TextEncodeQwenImage21")) {
    const name = basename(value);
    if (classType === "UNETLoader" && input === "unet_name" && (/qwen[-_ ]image[-_ ]edit|2511/.test(name) || (qwen21(value) && !/turbo/.test(name)))) return "此入口是完整 Qwen 2.1 Turbo 9步编辑链，不能混入2511或普通非Turbo的2.1主模型；普通模型还需不同采样配置。";
    if (classType === "CLIPLoader" && input === "clip_name" && (h3Encoder(value) || /qwen[-_ ]?2[._-]5/.test(name))) return "Qwen 2.1 编辑链使用匹配的 Qwen3VL 8B 编码器，不能使用 H3 专用或 Qwen 2.5 VL 编码器。";
    if (classType === "VAELoader" && input === "vae_name" && /^(?:qwen_image_vae|wan.*vae)[._-]/.test(name)) return "Qwen 2.1 需要2.1专用VAE（64通道二维latent），不能使用旧Qwen/Wan型VAE（含时间维latent）。";
    if (/^LoraLoader/.test(classType || "") && input === "lora_name" && /2511|2509/.test(name)) return "Qwen 2511/2509 的编辑LoRA不能用于Qwen 2.1主模型。";
    return "";
  }
  if (entry?.id !== "creation-image-qwen-edit" || !Object.values(graph).some(node => node?.class_type === "TextEncodeQwenImageEditPlus")) return "";
  if (classType === "UNETLoader" && input === "unet_name" && qwen21(value)) {
    return "Qwen 2511 编辑工作流不能只替换为 Qwen Image 2.1 主模型：旧版 VAE/条件编码链与 2.1 的四维 latent 输入不兼容，会触发 too many values to unpack (expected 4)。请恢复兼容的 2511 主模型，或明确切换整套 Qwen 2.1 工作流。";
  }
  if (classType === "CLIPLoader" && input === "clip_name" && (h3Encoder(value) || qwen3Encoder(value))) {
    return "Qwen 2511 编辑工作流需要匹配的 Qwen 2.5 VL 文本编码器；H3/Qwen3 VL 编码器不能仅改文件名接入旧版 TextEncodeQwenImageEditPlus。请恢复匹配编码器，或切换整套工作流。";
  }
  if (classType === "VAELoader" && input === "vae_name" && qwen21(value)) {
    return "Qwen 2.1 VAE 不能单独混入 Qwen 2511 编辑工作流；latent 通道/维度及条件编码必须整套匹配。";
  }
  if (/^LoraLoader/.test(classType || "") && input === "lora_name" && qwen21(value)) {
    return "Qwen 2.1 LoRA 与当前 Qwen 2511 主模型/4步采样链不匹配，请使用同架构的 LoRA。";
  }
  return "";
}

export function workflowModelCompatibilityProblems(entry, workflow = entry?.workflow) {
  const problems = [];
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    for (const input of ["unet_name", "clip_name", "vae_name", "lora_name"]) {
      const value = node.inputs?.[input];
      if (typeof value !== "string") continue;
      const message = workflowModelCompatibilityProblem(entry, nodeId, input, value);
      if (message) problems.push({ type: "compatibility", nodeId, classType: node.class_type, input, value, message });
    }
  }
  return problems;
}

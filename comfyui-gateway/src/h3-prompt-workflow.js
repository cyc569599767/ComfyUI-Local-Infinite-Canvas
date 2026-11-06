// H3 local prompt graph preflight. No node installation, model substitution,
// cloud fallback or inference is performed here.
export class LocalH3DependencyError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "LocalH3DependencyError";
    this.status = 400;
    this.code = code;
    this.details = details;
  }
}

function optionsOf(definition) {
  return Array.isArray(definition?.[0]) ? definition[0] : Array.isArray(definition?.[1]?.options) ? definition[1].options : null;
}
const basename = value => String(value).replace(/\\/g, "/").split("/").at(-1).toLowerCase();

export function validateLocalH3Workflow(workflow, objectInfo, { hasImages = false } = {}) {
  const missingNodes = [...new Set(Object.values(workflow).map(node => node.class_type).filter(type => !objectInfo?.[type]))];
  if (missingNodes.length) {
    throw new LocalH3DependencyError(
      `H3 本地提示词优化缺少 ComfyUI 节点：${missingNodes.join("、")}。请安装/启用 ComfyUI-llama-cpp 与 TE_MAN；多图所需 CreateList 需更新 ComfyUI 核心。完成后重启 ComfyUI；不会自动切换云端。`,
      "h3_prompt_missing_nodes", { missingNodes },
    );
  }
  const loader = workflow["1"].inputs;
  const schema = objectInfo.llama_cpp_model_loader?.input?.required || {};
  for (const field of ["model", "mmproj"]) {
    const options = optionsOf(schema[field]);
    if (!options) continue;
    let value = loader[field];
    if (!options.includes(value)) {
      // Same filename in an extra-model-path subdirectory is not a different model.
      const identical = options.filter(option => typeof option === "string" && basename(option) === basename(value));
      if (identical.length === 1) loader[field] = value = identical[0];
      else {
        const vision = field === "mmproj" && hasImages;
        throw new LocalH3DependencyError(
          vision
            ? `H3 看图提示词优化缺少匹配的视觉投影 ${value}。请在“添加工作流 → 本地反推/提示词”安装 Qwen3.5-9B 的 mmproj，或明确配置匹配的模型/投影；其他版本（如 Qwen3.8）的投影不能自动混用。纯文本优化不需要该文件。`
            : `H3 本地提示词优化找不到 ${field}：${value}。请安装对应资源或明确配置模型替换，并刷新 ComfyUI 模型目录。`,
          vision ? "h3_prompt_missing_mmproj" : "h3_prompt_missing_model", { field, value },
        );
      }
    }
  }
  const issues = [];
  for (const [id, node] of Object.entries(workflow)) {
    const info = objectInfo[node.class_type];
    for (const [field, definition] of Object.entries(info.input?.required || {})) {
      if (node.class_type === "CreateList" && field === "inputs" && definition?.[0] === "COMFY_AUTOGROW_V3") {
        const count = Object.keys(node.inputs).length;
        if (count < 1 || count > 8 || !Array.from({ length: count }, (_, i) => `inputs.input${i}`).every(key => key in node.inputs) || info.output_is_list?.[0] !== true) issues.push("CreateList 图像列表接口不兼容");
        continue;
      }
      if (!(field in node.inputs)) issues.push(`${node.class_type}.${field} 缺少输入`);
      else {
        const options = optionsOf(definition);
        const value = node.inputs[field];
        // LoadImage validates uploaded paths itself; its dropdown is a directory
        // snapshot and may omit just-uploaded files or files in subfolders.
        const uploadedPath = node.class_type === "LoadImage" && field === "image";
        if (!uploadedPath && options && !Array.isArray(value) && !options.includes(value)) issues.push(`${node.class_type}.${field} 不支持当前选项`);
      }
    }
    for (const value of Object.values(node.inputs)) {
      if (!Array.isArray(value)) continue;
      const source = workflow[value[0]];
      if (!source || !Number.isInteger(value[1]) || value[1] < 0 || !objectInfo[source.class_type]?.output?.[value[1]]) issues.push(`节点 ${id} 的输入连接无效`);
    }
  }
  if (issues.length) throw new LocalH3DependencyError(`H3 本地优化节点接口不兼容：${issues.slice(0, 6).join("；")}。请更新对应节点包并重启 ComfyUI。`, "h3_prompt_node_incompatible", { issues });
  return workflow;
}

import { BindingError } from "./bindings.js";

const TYPES = {
  image: { context: "uploadedImages", classType: "LoadImage", input: "image", limit: "maxImages", max: 9 },
  audio: { context: "uploadedAudios", classType: "LoadAudio", input: "audio", limit: "maxAudios", max: 3 },
  video: { context: "uploadedVideos", classType: "LoadVideo", input: "file", limit: "maxVideos", max: 3 },
};

// references 只描述上传数组中的顺序，不接受任意本地路径；编号与提示词里的 REF_n 一致。
export function h3EasyReferences(context, binding) {
  const references = [];
  for (const [type, spec] of Object.entries(TYPES)) {
    const files = context[spec.context] || [];
    const max = binding[spec.limit] ?? spec.max;
    if (files.length > max) throw new BindingError(`H3Easy 最多支持 ${max} 个 ${type} 素材。`, { code: "too_many_reference_media" });
    files.forEach((_, index) => references.push({ type, index }));
  }
  if (!references.length) throw new BindingError("H3Easy 参考模式需要至少一个图像、音频或视频。", { code: "missing_reference_media" });
  const ordered = context.params?.references ?? references;
  if (!Array.isArray(ordered) || ordered.length !== references.length) {
    throw new BindingError("params.references 必须完整列出全部上传素材的 type/index。", { code: "invalid_reference_order" });
  }
  const seen = new Set();
  for (const ref of ordered) {
    const spec = TYPES[ref?.type];
    const id = `${ref?.type}:${ref?.index}`;
    if (!spec || !Number.isInteger(ref.index) || ref.index < 0 || !context[spec.context]?.[ref.index] || seen.has(id)) {
      throw new BindingError("params.references 包含无效、越界或重复的 type/index。", { code: "invalid_reference_order" });
    }
    seen.add(id);
  }
  return ordered;
}

export function bindH3EasyMedia(workflow, binding, context) {
  const inputs = workflow[binding.node]?.inputs;
  if (!inputs) throw new BindingError(`H3Easy 媒体承载节点 ${binding.node} 不存在。`);
  const references = h3EasyReferences(context, binding);
  for (const key of Object.keys(inputs)) {
    if (key === "media" || /^media_(?:type_)?\d+$/.test(key) || /^prompt_optimizer_(resources|marker|prompt_connected)$/.test(key)) delete inputs[key];
  }
  let nextId = 9101;
  references.forEach((ref, index) => {
    const spec = TYPES[ref.type];
    const uploaded = context[spec.context][ref.index];
    if (!uploaded?.name) throw new BindingError("上传素材缺少 ComfyUI 文件名。", { code: "invalid_reference_media" });
    while (workflow[String(nextId)]) nextId += 1;
    const id = String(nextId++);
    workflow[id] = {
      class_type: spec.classType,
      inputs: { [spec.input]: uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name },
      _meta: { title: `创作参考素材 ${index + 1}` },
    };
    // H3Easy 接收原生 VIDEO 对象，不能换成 VHS 帧列表或 GetVideoComponents。
    inputs[`media_${index + 1}`] = [id, 0];
    inputs[`media_type_${index + 1}`] = ref.type;
  });
}

export function h3EasyBinding(entry) {
  return Object.values(entry?.bindings || {}).find((binding) => binding?.h3EasyMedia);
}

export function h3EasyUploadFiles(files = []) {
  const result = { uploadedImages: [], uploadedAudios: [], uploadedVideos: [] };
  for (const file of files) {
    const name = file.fieldname || "";
    const type = /^images?(?:\[\]|\d+)?$/i.test(name) ? "image"
      : /^audios?(?:\[\]|\d+)?$/i.test(name) ? "audio"
        : /^videos?(?:\[\]|\d+)?$/i.test(name) ? "video" : "";
    if (!type || !file.buffer) throw new BindingError(`不支持的 H3Easy 上传字段 ${name}。`, { code: "invalid_reference_media" });
    result[TYPES[type].context].push(file);
  }
  return result;
}

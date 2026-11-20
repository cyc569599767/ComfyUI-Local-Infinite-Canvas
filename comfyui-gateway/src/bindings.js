import crypto from "node:crypto";

import { clamp, deepClone, parseSize } from "./util.js";
import { bindH3EasyMedia } from "./h3-easy-media.js";
import { pruneToOutputs } from "./creation-workflows.js";

export class BindingError extends Error {
  constructor(message, { code = "binding_error", details } = {}) {
    super(message);
    this.name = "BindingError";
    this.status = 400;
    this.code = code;
    this.details = details;
  }
}

export function buildContext({ prompt, negative, size, count, quality, seconds, mode, images = [], uploadedImages = [], uploadedVideos = [], uploadedAudios = [], params = {}, presets = {}, background, lyrics, voiceDescription } = {}) {
  const parsedSize = parseSize(size);
  const qualityValue = String(quality || "auto").trim().toLowerCase() || "auto";
  const preset = presets?.quality?.[qualityValue] || {};
  return {
    prompt: String(prompt || ""),
    negative: negative === undefined || negative === null ? undefined : String(negative),
    size: parsedSize ? { width: parsedSize.width, height: parsedSize.height, raw: parsedSize.raw } : undefined,
    outputSize: parseSize(params?.editCanvasSize) || undefined,
    count: clamp(Number(count) || 1, 1, 15),
    quality: { value: qualityValue, ...preset },
    seconds: Number(seconds) > 0 ? Number(seconds) : undefined,
    mode: mode ? String(mode) : undefined,
    background: background ? String(background) : undefined,
    // 音频专用：音乐歌词（空串=纯器乐）与音色设计的音色描述。
    lyrics: lyrics === undefined || lyrics === null ? undefined : String(lyrics),
    voiceDescription: voiceDescription === undefined || voiceDescription === null ? undefined : String(voiceDescription),
    images,
    uploadedImages,
    uploadedVideos,
    uploadedAudios,
    params: params && typeof params === "object" ? params : {},
  };
}

export function resolvePath(context, path) {
  if (!path) return undefined;
  let current = context;
  for (const part of String(path).split(".")) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function secondsToFrames(seconds, fps = 16) {
  const raw = Math.max(1, Math.round(Number(seconds) * Number(fps || 16)));
  // Wan / LTX 类节点普遍要求 4n+1 帧。
  return 4 * Math.round((raw - 1) / 4) + 1;
}

function secondsToFrames17(seconds, fps = 24) {
  const raw = Math.max(5, Math.round(Number(seconds) * Number(fps || 24)));
  // MiniMax-H3 要求向上取到 17k+5 帧（124 ≈ 5s @ 24fps）。
  return raw + ((5 - (raw % 17) + 17) % 17);
}

const QWEN21_BASE_SIGMAS = [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0];

function qwen21Sigmas(value) {
  const steps = Math.max(1, Math.min(50, Math.trunc(Number(value) || 8)));
  if (steps === QWEN21_BASE_SIGMAS.length - 1) return QWEN21_BASE_SIGMAS.join(", ");
  // 用户自定义步数时，按 8 步官方 sigma 轨迹做线性插值；不改变 8 步默认路径。
  const last = QWEN21_BASE_SIGMAS.length - 1;
  const sigmas = [];
  for (let index = 0; index <= steps; index += 1) {
    const position = (index / steps) * last;
    const lower = Math.floor(position);
    const upper = Math.min(last, lower + 1);
    const fraction = position - lower;
    sigmas.push(QWEN21_BASE_SIGMAS[lower] + (QWEN21_BASE_SIGMAS[upper] - QWEN21_BASE_SIGMAS[lower]) * fraction);
  }
  return sigmas.map((item) => Number(item.toFixed(6))).join(", ");
}

function applyTransform(value, binding) {
  switch (binding.transform) {
    case "creationH3Resolution": {
      const resolution = typeof value === "string" ? value.trim().toUpperCase() : "";
      if (!["360P", "480P", "540P", "720P", "768P"].includes(resolution)) {
        throw new BindingError("普通创作 H3 分辨率仅支持 360P、480P、540P、720P、768P；1080P 请使用 creation-video-h3-1080 专用工作流。", { code: "invalid_resolution" });
      }
      return resolution;
    }
    case "lyricsOrSpace":
      return String(value ?? "").trim() ? String(value) : " ";
    case "qwenSigmas":
      return qwen21Sigmas(value);
    case "secondsToFrames":
      return secondsToFrames(value, binding.fps || 16);
    case "secondsToFrames17":
      return secondsToFrames17(value, binding.fps || 24);
    case "snap16":
      return Math.max(16, Math.ceil(Number(value) / 16) * 16);
    case "snap32":
      return Math.max(32, Math.round(Number(value) / 32) * 32);
    case "round":
      return Math.round(Number(value));
    case "int":
      return Math.trunc(Number(value));
    case "float":
      return Number(value);
    case "invert10":
      return 10 - Number(value);
    case "boolean":
      return Boolean(value);
    default:
      return value;
  }
}

function imageValue(uploaded) {
  if (!uploaded) return undefined;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function nextGatewayLoadId(workflow) {
  let id = 9101;
  while (workflow[String(id)]) id += 1;
  return String(id);
}

export function applyBindings(workflow, entry, context, { logger, stats } = {}) {
  const next = deepClone(workflow);

  for (const [key, value] of Object.entries(entry.defaults || {})) {
    const [nodeId, input] = String(key).split(".");
    if (next[nodeId]?.inputs && input in next[nodeId].inputs) next[nodeId].inputs[input] = value;
  }

  for (const [key, binding] of Object.entries(entry.bindings || {})) {
    if (!binding || !binding.node || !binding.input) continue;
    if (Array.isArray(binding.modes) && !binding.modes.map(String).includes(String(context.mode || ""))) continue;
    const node = next[binding.node];
    if (binding.h3EasyMedia) {
      bindH3EasyMedia(next, binding, context);
      continue;
    }
    const isImageBinding = binding.from === "image" || binding.imageIndex !== undefined;
    if (!node?.inputs || (!(binding.input in node.inputs) && !isImageBinding && !binding.array)) {
      if (entry.strictModelNames) throw new BindingError(`创作工作流绑定无效：${binding.node}.${binding.input}`, { code: "invalid_workflow_binding" });
      logger?.warn?.(`binding ${key} 指向 ${binding.node}.${binding.input}，但工作流里没有这个输入，已跳过。`);
      continue;
    }

    if (binding.frameMode) {
      const images = (context.uploadedImages || []).slice(0, Number(binding.max || 2));
      const mode = String(context.params?.frameMode || (images.length >= 2 ? "both" : "first"));
      delete node.inputs[binding.firstInput || "first_frame"];
      delete node.inputs[binding.lastInput || "last_frame"];
      if (mode === "text") continue;
      const need = mode === "both" ? 2 : 1;
      if (images.length < need) {
        throw new BindingError(`首尾帧模式需要 ${need} 张图，但请求里只有 ${images.length} 张。`, { code: "missing_reference_image" });
      }
      const targets = [];
      if (mode === "first" || mode === "both") targets.push([binding.firstInput || "first_frame", images[0]]);
      if (mode === "last") targets.push([binding.lastInput || "last_frame", images[0]]);
      if (mode === "both") targets.push([binding.lastInput || "last_frame", images[1]]);
      for (const [input, uploaded] of targets) {
        const loadNodeId = nextGatewayLoadId(next);
        next[loadNodeId] = {
          class_type: "LoadImage",
          inputs: { image: imageValue(uploaded) },
          _meta: { title: `Gateway Frame ${input}` },
        };
        node.inputs[input] = [loadNodeId, 0];
      }
      continue;
    }

    if (binding.from === "video" && !binding.array) {
      const index = Number.isInteger(binding.videoIndex) ? binding.videoIndex : 0;
      const uploaded = context.uploadedVideos?.[index];
      const value = imageValue(uploaded);
      if (value !== undefined) {
        node.inputs[binding.input] = value;
      } else if (binding.required) {
        throw new BindingError(`工作流 ${entry.name} 缺少输入视频。`, { code: "missing_reference_media" });
      }
      continue;
    }

    // 单条参考音频（音色克隆的 LoadAudio）：audio 是文件名 combo，必须写字符串而不是上传对象。
    if (binding.from === "audio" && !binding.array) {
      const index = Number.isInteger(binding.audioIndex) ? binding.audioIndex : 0;
      const uploaded = context.uploadedAudios?.[index];
      const value = imageValue(uploaded);
      if (value !== undefined) {
        node.inputs[binding.input] = value;
      } else if (binding.required) {
        throw new BindingError(`工作流 ${entry.name} 缺少参考音频。`, { code: "missing_reference_audio" });
      }
      continue;
    }

    if (binding.array) {
      const isVideo = binding.loadType === "video" || binding.from === "video";
      const isAudio = binding.loadType === "audio" || binding.from === "audio";
      const media = (isVideo ? context.uploadedVideos : isAudio ? context.uploadedAudios : context.uploadedImages) || [];
      if (entry.strictModelNames && binding.max && media.length > Number(binding.max)) throw new BindingError(`创作工作流最多接收 ${binding.max} 个参考素材，收到 ${media.length} 个，不能静默截断。`, { code: "too_many_reference_media" });
      const selected = media.slice(0, Number(binding.max || 8));
      const min = Number(binding.min || 0);
      if (selected.length < min) {
        throw new BindingError(`工作流需要至少 ${min} 个参考素材，但请求里只有 ${selected.length} 个。`, { code: "missing_reference_media" });
      }
      const prefix = String(binding.inputPrefix || binding.input || "ref_images.ref_image_");
      const indexBase = Number.isInteger(binding.indexBase) ? binding.indexBase : 0;
      for (const input of Object.keys(node.inputs)) {
        if (input.startsWith(prefix)) delete node.inputs[input];
      }
      selected.forEach((uploaded, index) => {
        const loadNodeId = nextGatewayLoadId(next);
        // Viggle 的源视频与参考图落在同名单槽位输入上（source / ref_1），
        // singleInput 让「单个素材写固定键、多个素材写前缀编号」两种形态共用一个绑定。
        const inputKey = binding.singleInput ? String(binding.singleInput) : `${prefix}${indexBase + index}`;
        if (isVideo && binding.loader === "native") {
          next[loadNodeId] = {
            class_type: "LoadVideo",
            inputs: { file: imageValue(uploaded) },
            _meta: { title: `Gateway Video ${index + 1}` },
          };
          const componentsId = nextGatewayLoadId(next);
          next[componentsId] = {
            class_type: "GetVideoComponents",
            inputs: { video: [loadNodeId, 0] },
            _meta: { title: `Gateway Video Frames ${index + 1}` },
          };
          node.inputs[`${prefix}${indexBase + index}`] = [componentsId, 0];
          if (binding.sourceLengthInput) {
            const frames = Math.round(Number(context.sourceVideoFrames));
            if (Number.isFinite(frames) && frames > 0) node.inputs[binding.sourceLengthInput] = frames;
          }
          return;
        }
        if (isVideo) {
          // Viggle 这类「整段源视频」工作流需要把源帧数同时用作加载上限和目标长度，
          // sourceLengthStatic 表示长度直接写字面值，而不是连加载节点的帧数输出。
          const sourceFrames = Math.round(Number(context.sourceVideoFrames));
          const frameLoadCap = binding.sourceLengthStatic && Number.isFinite(sourceFrames) && sourceFrames > 0
            ? sourceFrames
            : Number(binding.frameLoadCap ?? 0);
          next[loadNodeId] = {
            class_type: "VHS_LoadVideo",
            inputs: {
              video: imageValue(uploaded),
              force_rate: Number(binding.forceRate ?? 0),
              custom_width: 0,
              custom_height: 0,
              frame_load_cap: frameLoadCap,
              skip_first_frames: Number(context.sourceSkipFrames ?? 0),
              select_every_nth: 1,
              format: "AnimateDiff",
            },
            _meta: { title: `Gateway Video ${index + 1}` },
          };
        } else if (isAudio) {
          next[loadNodeId] = {
            class_type: "LoadAudio",
            inputs: { audio: imageValue(uploaded) },
            _meta: { title: `Gateway Audio ${index + 1}` },
          };
        } else {
          next[loadNodeId] = {
            class_type: "LoadImage",
            inputs: { image: imageValue(uploaded) },
            _meta: { title: `Gateway Ref ${index + 1}` },
          };
        }
        node.inputs[inputKey] = [loadNodeId, 0];
        if (isVideo && (binding.audioInput || binding.audioPrefix)) {
          const audioKey = binding.audioInput ? String(binding.audioInput) : `${binding.audioPrefix}${indexBase + index}`;
          node.inputs[audioKey] = [loadNodeId, 2];
        }
        if (isVideo && binding.sourceLengthInput) {
          if (binding.sourceLengthStatic) {
            const frames = Math.round(Number(context.sourceVideoFrames));
            if (Number.isFinite(frames) && frames > 0) node.inputs[binding.sourceLengthInput] = frames;
          } else {
            const sourceLengthOutput = Number.isInteger(binding.sourceLengthOutput) ? binding.sourceLengthOutput : 1;
            node.inputs[binding.sourceLengthInput] = [loadNodeId, sourceLengthOutput];
          }
        }
      });
      continue;
    }

    if (isImageBinding) {
      const index = Number.isInteger(binding.imageIndex) ? binding.imageIndex : 0;
      const uploaded = context.uploadedImages?.[index];
      const value = imageValue(uploaded);
      if (value !== undefined) {
        if (binding.asLink) {
          // H3 的可选帧/参考图是 IMAGE 类型 socket，必须挂 LoadImage 连线，不能直接塞文件名。
          let loadNodeId = binding.loadNodeId;
          if (!loadNodeId) {
            let candidate = 9001;
            while (next[String(candidate)]) candidate += 1;
            loadNodeId = String(candidate);
          }
          next[loadNodeId] = {
            class_type: "LoadImage",
            inputs: { image: value },
            _meta: { title: `Gateway Load ${index + 1}` },
          };
          node.inputs[binding.input] = [loadNodeId, 0];
        } else {
          node.inputs[binding.input] = value;
        }
      } else if (binding.required) {
        throw new BindingError(`工作流 ${entry.name} 需要第 ${index + 1} 张参考图，但请求里没有。`, { code: "missing_reference_image" });
      }
      continue;
    }

    let value;
    if (binding.value !== undefined) value = binding.value;
    else if (binding.from) value = resolvePath(context, binding.from);
    else if (key in context) value = context[key];

    // 严格枚举仅在未传值时使用默认值，显式 null/空串必须进入校验。
    const strictResolution = binding.transform === "creationH3Resolution";
    if ((value === undefined || value === null || value === "") && binding.random) value = crypto.randomInt(1, 2147483647);
    if ((value === undefined || (!strictResolution && (value === null || value === ""))) && binding.default !== undefined) value = binding.default;
    if (value === undefined || (!strictResolution && value === null) || (binding.required && typeof value === "string" && !value.trim())) {
      if (binding.required) throw new BindingError(`缺少必填参数：${key}`, { code: "missing_parameter" });
      continue;
    }
    if (binding.map) {
      // 映射表故意不覆盖全部取值时（如 RelayVSR 只认 2/4 倍率），未命中的值必须回落到
      // default 再写回，否则会把「3」这样的档位当成模型文件名提交，ComfyUI 会直接报缺文件。
      // 判定必须用映射前的原值：映射后的值已经是文件名，再查一次表会永远落空。
      const raw = value;
      value = Object.prototype.hasOwnProperty.call(binding.map, raw) ? binding.map[raw] : binding.default !== undefined ? binding.default : value;
    }
    value = applyTransform(value, binding);
    node.inputs[binding.input] = value;
    if (key === "seed") {
      context.usedSeed = value;
      if (stats) stats.seed = value;
    }
  }

  const outputSize = entry.outputSize?.fromSize ? context.size : context.outputSize;
  const nativeResolution = Math.max(256, Math.round((Number(context.params?.resolution) || 1024) / 32) * 32);
  const skipNativeSquare = Boolean(
    entry.outputSize?.skipNativeSquare &&
    outputSize &&
    outputSize.width === outputSize.height &&
    Math.round(outputSize.width / 32) * 32 === nativeResolution,
  );
  if (entry.outputSize && outputSize && !skipNativeSquare) {
    const sizeNode = next[entry.outputSize.node];
    const latentNode = next[entry.outputSize.latentNode];
    if (sizeNode?.inputs && latentNode?.inputs) {
      const snap = (value) => Math.max(256, Math.round(Number(value) / 32) * 32);
      sizeNode.inputs.width = snap(outputSize.width);
      sizeNode.inputs.height = snap(outputSize.height);
      latentNode.inputs[entry.outputSize.latentInput || "latent_image"] = [entry.outputSize.latentSource || entry.outputSize.node, 0];
    }
  }

  return entry.outputNodes?.length ? pruneToOutputs(next, entry.outputNodes) : next;
}

export { secondsToFrames, secondsToFrames17 };

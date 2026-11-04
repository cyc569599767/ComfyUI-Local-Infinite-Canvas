import fs from "node:fs";
import path from "node:path";

import { sleep } from "./util.js";

// ComfyUI 0.43 起把 RIFE/FILM 插帧收进核心（comfy_extras.nodes_frame_interpolation）：
// 先 FrameInterpolationModelLoader 载入权重，再 FrameInterpolate 执行。
// 旧的第三方插件类名 "RIFE VFI" 在未装插件时会直接报 missing_node_type，
// 因此内嵌工作流统一走核心节点，并在这里按实际可用文件挑选权重。
const INTERP_LOADER_CLASS = "FrameInterpolationModelLoader";
const INTERP_CLASS = "FrameInterpolate";

// 优先用体积/速度均衡的 v4.26；heavy 更准更慢，lite 更快更糊，FILM 作为兜底。
const MODEL_PREFERENCE = [
  /^rife_v?4\.26\.safetensors$/i,
  /^rife_v?4\.25\.safetensors$/i,
  /^rife_v?4\.26_lite\.safetensors$/i,
  /^rife_v?4\.25_lite\.safetensors$/i,
  /^rife_v?4\.26_heavy\.safetensors$/i,
  /^rife.*\.safetensors$/i,
  /^film.*\.safetensors$/i,
];

// 问不到清单时（例如 ComfyUI 暂时不可达）仍按资源中心安装的默认权重提交，
// 让 ComfyUI 自己报缺文件的错，而不是在网关侧编造一个更含糊的失败。
const DEFAULT_MODEL = "rife_v4.26.safetensors";

function pickInterpolationModel(options) {
  const names = (Array.isArray(options) ? options : []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!names.length) return "";
  for (const pattern of MODEL_PREFERENCE) {
    const hit = names.find((name) => pattern.test(path.basename(name)));
    if (hit) return hit;
  }
  return names[0];
}

export function createVideoInterpolator({ config, logger } = {}) {
  const workflowPath = path.join(config.workflowDir, "_internal", "video-rife.json");
  // /object_info 在装满插件的整合包上有数 MB，一次插帧只查一次并短时缓存。
  let probe = null;

  function template() {
    return JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  }

  async function loadObjectInfo(comfy, signal) {
    if (typeof comfy?.objectInfo !== "function") return null;
    const cached = probe && Date.now() - probe.at < 60000 ? probe : null;
    if (cached) return cached.info;
    try {
      const info = await comfy.objectInfo({ signal });
      if (info) probe = { at: Date.now(), info };
      return info || null;
    } catch {
      return null;
    }
  }

  // 权重由用户在资源中心安装，文件名不定；向 ComfyUI 现问可用列表比写死安全。
  async function resolveTarget(comfy, signal) {
    const info = await loadObjectInfo(comfy, signal);
    // 问不到清单时不硬拦，交给 ComfyUI 自己报错。
    if (!info) return { modelName: String(config.interpolationModel || "").trim() || DEFAULT_MODEL, missing: [], probed: false };
    const missing = [INTERP_LOADER_CLASS, INTERP_CLASS].filter((name) => !info[name]);
    const loader = info[INTERP_LOADER_CLASS];
    // 老版/新版 object_info 分别把选项放在 [0] 或 ["COMBO", { options }]。
    const definition = loader?.input?.required?.model_name ?? loader?.input?.optional?.model_name;
    const options = Array.isArray(definition?.[0]) ? definition[0] : Array.isArray(definition?.[1]?.options) ? definition[1].options : null;
    const explicit = String(config.interpolationModel || "").trim();
    const modelName = explicit && (!options || options.includes(explicit)) ? explicit : pickInterpolationModel(options);
    return { modelName, missing, probed: true };
  }

  // 提前把缺失的类名翻成人话，避免把 ComfyUI 的 missing_node_type 原样抛给用户。
  function assertSupported({ missing }) {
    if (missing.length) {
      throw new Error(
        `当前 ComfyUI 不支持核心插帧节点（缺少 ${missing.join("、")}，需要 ComfyUI 0.43 及以上）：请升级 ComfyUI 后再试。`,
      );
    }
  }

  function assertModel({ modelName, probed }) {
    if (probed && !modelName) {
      throw new Error(
        "缺少插帧模型：请在「资源中心 → 超分」安装 RIFE 插帧模型（frame_interpolation/rife_v4.26.safetensors），安装后重新扫描再试。",
      );
    }
  }

  async function interpolate({ comfy, buffer, filename, multiplier, sourceFps = 24, requestId, signal, timeoutMs = 30 * 60 * 1000, onProgress }) {
    const factor = Number(multiplier);
    if (factor !== 2 && factor !== 3) throw new Error("插帧倍率仅支持 2× 或 3×");
    if (!buffer?.length) throw new Error("插帧缺少输入视频");
    const target = await resolveTarget(comfy, signal);
    assertSupported(target);
    assertModel(target);
    const modelName = target.modelName;
    const safeRequest = String(requestId || Date.now()).replace(/[^\w.-]+/g, "_");
    const uploaded = await comfy.uploadImage(buffer, `rife-${safeRequest}.mp4`, "video/mp4");
    const workflow = template();
    workflow["1"].inputs.video = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    const loaderNode = Object.values(workflow).find((node) => node.class_type === INTERP_LOADER_CLASS);
    if (!loaderNode) throw new Error("插帧工作流缺少模型加载节点");
    loaderNode.inputs.model_name = modelName;
    const interpNode = Object.values(workflow).find((node) => node.class_type === INTERP_CLASS);
    if (!interpNode) throw new Error("插帧工作流缺少插帧节点");
    interpNode.inputs.multiplier = factor;
    // 输出帧率必须跟随源视频，否则 30/60fps 素材会变速。
    const fps = Number(sourceFps) > 0 ? Number(sourceFps) : 24;
    const outputNode = Object.values(workflow).find((node) => node.class_type === "VHS_VideoCombine") || workflow["3"];
    if (!outputNode) throw new Error("插帧工作流缺少视频输出节点");
    outputNode.inputs.frame_rate = Number((fps * factor).toFixed(3));
    outputNode.inputs.filename_prefix = `rife/${safeRequest}`;
    const submitted = await comfy.submit(workflow, { signal, requestId, clientId: `rife-${Date.now()}` });
    const promptId = submitted.promptId;
    const started = Date.now();
    const deadline = started + timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await comfy.cancel?.(promptId).catch(() => undefined);
          throw new Error("插帧已取消");
        }
        const history = await comfy.history(promptId);
        const item = history?.[promptId] || history;
        if (item) {
          const status = item.status || {};
          if (status.status_str === "error") {
            const messages = Array.isArray(status.messages) ? status.messages.flat() : [];
            const detail = messages
              .map((entry) => (typeof entry === "string" ? entry : entry?.message || ""))
              .filter(Boolean)
              .join("；");
            throw new Error(`插帧失败：${detail || "ComfyUI 执行错误"}`);
          }
          const files = [];
          for (const output of Object.values(item.outputs || {})) {
            for (const key of ["gifs", "videos"]) {
              for (const file of output?.[key] || []) files.push(file);
            }
          }
          if (files.length) {
            const file = files[0];
            const viewed = await comfy.view({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
            logger?.info?.(`video interpolation ${factor}x ${promptId} ${Date.now() - started}ms`);
            onProgress?.({ phase: "completed", progress: 0.99 });
            return { buffer: viewed.buffer, filename: file.filename, mimeType: viewed.contentType || "video/mp4" };
          }
          if (status.completed) throw new Error("插帧工作流没有返回视频");
        }
        // 插帧没有逐帧预览，至少让进度条随耗时缓慢前进，避免用户误以为卡死。
        const elapsedMs = Date.now() - started;
        onProgress?.({ phase: "interpolating", progress: Math.min(0.99, 0.97 + elapsedMs / 60000 / 100), elapsedMs });
        await sleep(1500);
      }
      await comfy.cancel?.(promptId).catch(() => undefined);
      throw new Error("插帧超时，已取消 ComfyUI 中的任务");
    } catch (error) {
      // 超时/中断时要主动停掉 ComfyUI 任务，否则前端已经报错，显卡还在继续跑。
      if (/超时|取消/.test(String(error?.message || ""))) await comfy.cancel?.(promptId).catch(() => undefined);
      throw error;
    }
  }

  return { interpolate };
}

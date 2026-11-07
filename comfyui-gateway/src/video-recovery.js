import path from "node:path";

const VIDEO_MIMES = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

function recoveryError(message, code, status = 409) {
  return Object.assign(new Error(message), { name: "VideoRecoveryError", code, status });
}

function isImage(buffer) {
  const head = buffer.subarray(0, 16);
  const hex = head.toString("hex");
  if (/^(89504e470d0a1a0a|ffd8ff|474946383761|474946383961|424d|49492a00|4d4d002a)/.test(hex)) return true;
  // ICO/CUR 的前四字节也可能只是 MP4 box 长度，必须同时确认图片计数。
  if (/^00000[12]00/.test(hex) && head.length >= 6 && head.readUInt16LE(4) > 0 && head.readUInt16LE(4) <= 256) return true;
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return true;
  return head.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(head.toString("ascii", 8, 12));
}

function assertVideoBody(viewed) {
  const buffer = viewed?.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw recoveryError("ComfyUI 返回的视频内容为空或不是 Buffer", "recovery_invalid_video", 502);
  }
  const mime = String(viewed.contentType || "").split(";", 1)[0].trim().toLowerCase();
  if ((mime && mime !== "application/octet-stream" && !mime.startsWith("video/")) || isImage(buffer)) {
    throw recoveryError("ComfyUI 返回的不是视频内容，拒绝把图片或错误响应保存为视频", "recovery_invalid_video", 502);
  }
  // /view 的代理或上游也可能以 200/video/* 返回 JSON、HTML 或纯文本错误。
  const head = buffer.subarray(0, 512).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^[\[{<]/.test(head) || /^(error|exception|traceback|not found|forbidden|unauthorized|bad request|internal server error|service unavailable|gateway timeout|bad gateway|terminated|timed? out)\b/i.test(head) || /^[\x09\x0a\x0d\x20-\x7e]+$/.test(head)) {
    throw recoveryError("ComfyUI 返回了文本或错误响应，而不是视频文件", "recovery_invalid_video", 502);
  }
  return mime;
}

// 只取回既有 prompt 的唯一最终视频：不提交、不取消、不轮询，更不会采样或插帧。
export async function recoverCompletedVideo({ task, comfy, signal = new AbortController().signal } = {}) {
  if (!task || task.status !== "failed") {
    throw recoveryError("仅允许恢复失败的视频任务", "task_not_recoverable");
  }
  if (typeof task.promptId !== "string" || !task.promptId.trim()) {
    throw recoveryError("任务缺少原始 ComfyUI promptId，无法恢复", "recovery_missing_prompt_id");
  }
  if ((task.request?.interpolation ?? "off") !== "off") {
    throw recoveryError("插帧任务不能用原始视频冒充最终结果，暂不支持恢复", "recovery_interpolation_unsupported");
  }
  const promptId = task.promptId;
  signal.throwIfAborted();
  const history = await comfy.history(promptId, { signal });
  signal.throwIfAborted();
  const status = history?.status;
  const statusName = String(status?.status_str || "").toLowerCase();
  const executionError = Array.isArray(status?.messages) && status.messages.some((message) =>
    Array.isArray(message) && ["execution_error", "execution_interrupted"].includes(message[0]));
  if (!history || history.error || status?.error || executionError || ["error", "failed", "cancelled", "interrupted"].includes(statusName) || !(status?.completed === true || statusName === "success")) {
    throw recoveryError("ComfyUI 历史没有确认原始任务成功完成，不能恢复", "recovery_history_not_successful");
  }

  const candidates = new Map();
  for (const output of Object.values(history.outputs || {})) {
    for (const key of ["images", "gifs", "videos"]) {
      if (!Array.isArray(output?.[key])) continue;
      for (const file of output[key]) {
        if (file?.type !== "output" || typeof file.filename !== "string") continue;
        const ext = path.extname(file.filename).slice(1).toLowerCase();
        if (!Object.hasOwn(VIDEO_MIMES, ext)) continue;
        if (file.subfolder != null && typeof file.subfolder !== "string") continue;
        const descriptor = { filename: file.filename, subfolder: file.subfolder || "", type: "output" };
        candidates.set(JSON.stringify([descriptor.filename, descriptor.subfolder, descriptor.type]), { file: descriptor, ext });
      }
    }
  }
  if (candidates.size !== 1) {
    throw recoveryError(candidates.size ? "ComfyUI 历史包含多个不同视频，无法安全确定最终结果" : "ComfyUI 历史没有可恢复的最终视频", candidates.size ? "recovery_ambiguous_video" : "recovery_video_not_found");
  }

  const [{ file, ext }] = candidates.values();
  signal.throwIfAborted();
  const viewed = await comfy.view(file, { signal });
  signal.throwIfAborted();
  const contentType = assertVideoBody(viewed);
  return {
    buffer: viewed.buffer,
    ext,
    mimeType: contentType && contentType !== "application/octet-stream" ? contentType : VIDEO_MIMES[ext],
    promptId,
  };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extFromMime, randomId } from "./util.js";

// Hide the auxiliary ffprobe console, not its stdout/error/timeout semantics.
export function probeVideoInfo(file, extraProbes = [], { execute = execFileSync } = {}) {
  if (!file?.buffer?.length) return { fps: 0, duration: 0, frames: 0 };
  const rawExt = extFromMime(file.mimetype) || ".mp4";
  const ext = String(rawExt).startsWith(".") ? rawExt : `.${rawExt}`;
  const temp = path.join(os.tmpdir(), `comfy-probe-${randomId()}${ext}`);
  const candidates = ["ffprobe", ...extraProbes.filter(Boolean)];
  try {
    fs.writeFileSync(temp, file.buffer);
    for (const bin of candidates) {
      try {
        const raw = execute(bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-show_entries", "format=duration", "-of", "json", temp], {
          encoding: "utf8", timeout: 20000, windowsHide: true, shell: false,
        });
        const data = JSON.parse(raw);
        const rate = String(data.streams?.[0]?.avg_frame_rate || "0/1").split("/").map(Number);
        const fps = rate[1] ? rate[0] / rate[1] : rate[0];
        const duration = Number(data.format?.duration || 0);
        if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) continue;
        return { fps, duration, frames: Math.max(1, Math.round(fps * duration)) };
      } catch {
        // Preserve existing fallback: another configured probe may be usable.
      }
    }
    return { fps: 0, duration: 0, frames: 0 };
  } finally {
    try { fs.unlinkSync(temp); } catch { /* best-effort temporary cleanup */ }
  }
}

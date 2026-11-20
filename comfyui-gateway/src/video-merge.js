import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

import { randomId } from "./util.js";

// 视频编辑工作台的「导出时间线」最终要落成一个能直接播放的 mp4。
// 这一步放在网关：浏览器里用 ffmpeg.wasm 处理 1080p 素材太慢，而且需要额外 30MB 的 wasm，
// 而网关所在机器本来就要装 ffmpeg（超分/插帧链路已经在用 ffprobe）。
//
// 时间线以秒计时，重叠时只播放最上层镜头及其音频；空隙补黑场和静音。
// 轨道数值越小越靠上，同轨 layer 越大越靠上，最终用原数组 index 决胜。

const DEFAULT_FPS = 30;
const DEFAULT_SAMPLE_RATE = 48000;
export const MAX_MERGE_CLIPS = 120;

/** 参数类错误：带上 code，路由层可以直接翻成 400 而不是 500。 */
export class MergeParamError extends Error {
  constructor(message, code = "invalid_timeline") {
    super(message);
    this.name = "MergeParamError";
    this.code = code;
    this.status = 400;
  }
}

function even(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}

function formatSeconds(value) {
  // 保留微秒精度，短空隙和裁剪边界不能先被舍入为零。
  return Number(value).toFixed(6).replace(/(\.\d{3})0+$/, "$1");
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ffmpegBinaries(comfyDir) {
  const list = ["ffmpeg", "ffmpeg.exe"];
  if (comfyDir) {
    list.push(
      path.join(comfyDir, "ffmpeg.exe"),
      path.join(comfyDir, "..", "ffmpeg.exe"),
      path.join(comfyDir, "ffmpeg", "bin", "ffmpeg.exe"),
      path.join(comfyDir, "ffmpeg", "bin", "ffmpeg"),
    );
  }
  return list;
}

function ffprobeBinaries(comfyDir) {
  const list = ["ffprobe", "ffprobe.exe"];
  if (comfyDir) {
    list.push(
      path.join(comfyDir, "ffprobe.exe"),
      path.join(comfyDir, "..", "ffprobe.exe"),
      path.join(comfyDir, "ffmpeg", "bin", "ffprobe.exe"),
    );
  }
  return list;
}

/** 把工作台传来的片段整理成确定的数字，脏数据不能进 filter graph。 */
export function normalizeMergeClips(clips = []) {
  return clips.map((clip, index) => {
    const inPoint = Math.max(0, finiteNumber(clip?.inPoint));
    const rawOut = finiteNumber(clip?.outPoint);
    const duration = finiteNumber(clip?.duration);
    // 出点缺失/非法时退回整段素材：宁可多导一点，也不要 0 帧的空片段。
    const outPoint = rawOut > inPoint ? rawOut : duration > inPoint ? duration : inPoint + 1;
    const volume = Number(clip?.volume);
    return {
      index,
      inPoint,
      outPoint,
      duration: outPoint - inPoint,
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1,
      start: Math.max(0, finiteNumber(clip?.start)),
      track: Math.max(0, Math.round(finiteNumber(clip?.track))),
      layer: clip?.layer == null ? index + 1 : finiteNumber(clip.layer, index + 1),
    };
  });
}

/** 将全局时间线分成可见镜头区间；遮挡结束后从对应素材时间继续。 */
export function resolveTimelineSegments(normalizedClips) {
  const ordered = [...normalizedClips].sort((a, b) => a.track - b.track || b.layer - a.layer || b.index - a.index);
  const boundaries = [...new Set([0, ...normalizedClips.flatMap((clip) => [clip.start, clip.start + (clip.outPoint - clip.inPoint)])])].sort((a, b) => a - b);
  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    const clip = ordered.find((item) => item.start <= start && start < item.start + (item.outPoint - item.inPoint));
    const previous = segments.at(-1);
    if (previous && previous.clip === clip) {
      previous.duration = end - previous.start;
    } else {
      segments.push(clip
        ? { start, duration: end - start, clip, inPoint: clip.inPoint + start - clip.start }
        : { start, duration: end - start });
    }
  }
  return segments;
}

/**
 * 时间线描述（与视频编辑工作台一致）：
 * [{ source, inPoint, outPoint, duration, start, track, layer, volume }]
 *
 * source 指向上传素材，原数组顺序用于同轨同层的最终叠放优先级。
 */
export function parseMergeTimeline(value, { maxClips = MAX_MERGE_CLIPS } = {}) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new MergeParamError("timeline 必须是 JSON 数组", "invalid_timeline");
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new MergeParamError("未提供时间线片段（timeline 为空）", "invalid_timeline");
  }
  if (parsed.length > maxClips) {
    throw new MergeParamError(`一次最多合并 ${maxClips} 段视频，请拆成多条时间线`, "too_many_clips");
  }
  return parsed.map((item, index) => {
    const source = Number(item?.source);
    return {
      source: Number.isInteger(source) && source >= 0 ? source : index,
      inPoint: Math.max(0, finiteNumber(item?.inPoint)),
      outPoint: Math.max(0, finiteNumber(item?.outPoint)),
      duration: Math.max(0, finiteNumber(item?.duration)),
      start: Math.max(0, finiteNumber(item?.start)),
      track: Math.max(0, Math.round(finiteNumber(item?.track))),
      layer: item?.layer == null ? index + 1 : finiteNumber(item.layer, index + 1),
      volume: Number(item?.volume),
    };
  });
}

/** 成片尺寸取第一段素材（超分/插帧后的片段通常已是目标分辨率），并强制偶数。 */
export function resolveMergeSize(infos = [], override = {}) {
  const first = infos.find((info) => info && info.width > 0 && info.height > 0);
  const width = Number(override?.width) > 0 ? Number(override.width) : first?.width || 1280;
  const height = Number(override?.height) > 0 ? Number(override.height) : first?.height || 720;
  return { width: even(width), height: even(height) };
}

/**
 * 按可见区间统一 trim、尺寸、帧率与音频长度后 concat。
 * 一个素材可能被多次恢复，每个可见区间独立输入，避免重复消费同一 stream。
 */
export function buildMergeArgs({ clips, infos, output, fps = DEFAULT_FPS, sampleRate = DEFAULT_SAMPLE_RATE, size }) {
  const target = size || resolveMergeSize(infos);
  const targetFps = Number(fps) > 0 ? Number(fps) : DEFAULT_FPS;
  const filters = [];
  const segments = resolveTimelineSegments(clips);
  const args = ["-y", "-nostdin", "-hide_banner", "-loglevel", "error"];
  let inputIndex = 0;

  for (const [index, segment] of segments.entries()) {
    const { clip, duration } = segment;
    const seconds = formatSeconds(duration);
    if (!clip) {
      filters.push(`color=c=black:s=${target.width}x${target.height}:r=${targetFps}:d=${seconds},format=yuv420p,setsar=1[v${index}]`);
      filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`);
      continue;
    }

    const input = inputIndex++;
    args.push("-i", clip.file);
    const info = infos[clip.index] || {};
    const inSec = formatSeconds(segment.inPoint);
    const outSec = formatSeconds(segment.inPoint + duration);
    filters.push(
      `[${input}:v]trim=start=${inSec}:end=${outSec},setpts=PTS-STARTPTS,` +
        `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,` +
        `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps}[v${index}]`,
    );
    if (info.hasAudio) {
      // 先补源音轨再裁剪：恢复点可能已越过音轨末尾，空 atrim 结果无法可靠地补静音。
      filters.push(
        `[${input}:a]apad,atrim=start=${inSec}:end=${outSec},asetpts=PTS-STARTPTS,` +
          `volume=${clip.volume},aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`,
      );
    } else {
      filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`);
    }
  }

  const graph = [
    ...filters,
    `${segments.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${segments.length}:v=1:a=1[vout][aout]`,
  ].join(";");
  const last = segments.at(-1);
  args.push(
    "-filter_complex", graph,
    "-map", "[vout]",
    "-map", "[aout]",
    "-t", formatSeconds(last.start + last.duration),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    output,
  );
  return args;
}

function runProcess(bin, args, { signal, timeoutMs, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFileImpl(
      bin,
      args,
      { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (!child || typeof child.kill !== "function") return;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程可能已经退出，忽略。
      }
      const error = new Error("合并已取消");
      error.code = "cancelled";
      reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readProbe(execute, bin, file) {
  const raw = execute(
    bin,
    [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height,avg_frame_rate",
      "-show_entries", "format=duration",
      "-of", "json",
      file,
    ],
    { encoding: "utf8", timeout: 20000, windowsHide: true, shell: false },
  );
  const data = JSON.parse(raw);
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const rate = String(video?.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = rate[1] ? rate[0] / rate[1] : rate[0];
  return {
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    duration: Number(data?.format?.duration) || 0,
  };
}

export function createVideoMerger({ config = {}, logger, execute = execFileSync, run, execFileImpl } = {}) {
  const comfyDir = config.comfyDir || "";
  const probes = ffprobeBinaries(comfyDir);
  const encoders = ffmpegBinaries(comfyDir);
  const timeoutMs = Number(config.mergeTimeoutMs) > 0 ? Number(config.mergeTimeoutMs) : 15 * 60 * 1000;

  // ffprobe 不可用时不能直接失败：宁可让 ffmpeg 自己按「有音轨」去试，
  // 也不要因为探不到信息就拒绝一个本来能拼的请求。
  function probeFile(file) {
    for (const bin of probes) {
      try {
        return readProbe(execute, bin, file);
      } catch {
        // 换下一个候选。
      }
    }
    return { width: 0, height: 0, fps: 0, hasAudio: true, duration: 0 };
  }

  async function merge({ clips = [], size: sizeOverride, fps, requestId, signal, onProgress } = {}) {
    if (!clips.length) throw new Error("合并缺少视频片段");
    if (clips.length > MAX_MERGE_CLIPS) throw new Error(`一次最多合并 ${MAX_MERGE_CLIPS} 段视频，请拆成多条时间线`);
    const normalized = normalizeMergeClips(clips);
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `comfy-merge-${randomId()}-`));
    const output = path.join(workDir, "merged.mp4");
    try {
      onProgress?.({ phase: "preparing", progress: 0.05 });
      const prepared = [];
      for (const [index, clip] of normalized.entries()) {
        const file = path.join(workDir, `clip-${index}.mp4`);
        await fsp.writeFile(file, clips[index].buffer);
        prepared.push({ ...clip, file });
      }
      const infos = prepared.map((clip) => probeFile(clip.file));
      // 素材实际时长可能比工作台里记的短（比如导出的片段被重新编码过），
      // 出点越过末尾会让 trim 直接空掉，这里按实际时长收一下。
      prepared.forEach((clip, index) => {
        const real = infos[index]?.duration || 0;
        if (real > 0) {
          if (clip.inPoint >= real) {
            throw new MergeParamError(`第 ${index + 1} 个片段的入点 ${clip.inPoint}s 不小于素材实际时长 ${real}s`);
          }
          clip.outPoint = Math.min(clip.outPoint, real);
          clip.duration = clip.outPoint - clip.inPoint;
        }
      });
      const size = resolveMergeSize(infos, sizeOverride);
      const args = buildMergeArgs({
        clips: prepared,
        infos,
        output,
        size,
        fps: Number(fps) > 0 ? Number(fps) : infos.find((info) => info.fps > 0)?.fps || DEFAULT_FPS,
      });
      onProgress?.({ phase: "merging", progress: 0.2 });

      let lastError = null;
      for (const bin of encoders) {
        try {
          await (run ? run(bin, args, { signal, timeoutMs, execFileImpl }) : runProcess(bin, args, { signal, timeoutMs, execFileImpl }));
          const buffer = await fsp.readFile(output);
          if (!buffer.length) throw new Error("合并结果是空文件");
          logger?.info?.(`video merge ${prepared.length} clips ${buffer.length} bytes ${requestId || ""}`.trim());
          onProgress?.({ phase: "completed", progress: 0.99 });
          return { buffer, mimeType: "video/mp4", filename: "merged.mp4", width: size.width, height: size.height };
        } catch (error) {
          lastError = error;
          // 用户取消或超时不该再去试下一个二进制。
          if (signal?.aborted || error?.code === "cancelled") throw error;
          if (!isMissingBinary(error)) break;
        }
      }
      const detail = String(lastError?.stderr || lastError?.message || "").trim().split("\n").slice(-4).join(" ");
      throw new Error(
        lastError && isMissingBinary(lastError)
          ? "没有找到 ffmpeg：请在网关所在机器安装 ffmpeg（或把 ffmpeg.exe 放进 ComfyUI 目录）后再导出成片。"
          : `合并视频失败：${detail || "ffmpeg 执行错误"}`,
      );
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { merge, probeFile };
}

function isMissingBinary(error) {
  return error?.code === "ENOENT" || error?.code === "EACCES";
}

export const __test__ = { even, formatSeconds, ffmpegBinaries, ffprobeBinaries, isMissingBinary };

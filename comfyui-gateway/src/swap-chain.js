import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { extractVideoFrame, scoreVideoFrames } from "./viggle-long.js";
import { alignViggleFramesUp, randomId, sleep } from "./util.js";

const execFileAsync = promisify(execFile);

// 图像画布不再是常量：必须按源片朝向算，否则竖屏素材会被裁成横屏条带。
// 具体尺寸由 pickImageCanvas(源宽, 源高) 在 run() 里算出后放进 job.imageSize。
const IMAGE_SIZE = { width: 832, height: 480 }; // 仅作源尺寸未知时的兜底
const DEFAULT_SEED = 98742863019142;
const MAX_IMAGE_RETRIES = 2;
const MAX_VIDEO_RETRIES = 1;
const FRAMES = 124;
const REMAKE_FRAMES_MIN = 90;
const REMAKE_FRAMES_MAX = 345;
import { pickImageCanvas, pickRemakeShortEdge } from "./remake-canvas.js";
import { buildSingleSwapPrompt, buildSwapVideoPrompt, defaultTargetBoxes, isFullFrameBox, isPromptInQueue, judgeImageGate, judgeVideoGate } from "./swap-chain-target.js";

const DEFAULT_SHORT_EDGE = 480;
const SWAP_SIGMAS = "1.0, 0.990476, 0.965243, 0.923077, 0.8, 0.631579, 0.0";
const EDIT_SIGMAS = "1.0, 0.983607, 0.96, 0.923077, 0.857143, 0.705882, 0.0";
const QWEN_SIGMAS = "1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.35, 0.152292, 0";
const QWEN_UNET = "qwen_image_2.1_bf16.safetensors";
const QWEN_LORA_6 = "p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors";
const QWEN_OLDX = "oldx-qwen2.1人物替换.safetensors";
const QWEN_CLIP = "qwen3vl_8b_int8_convrot.safetensors";
const QWEN_VAE = "qwen_image_2.1_vae_bf16.safetensors";
// ReActor 的人脸修复模型：先用 none，保持原始质感；装了 codeformer 可换。
const REACTOR_RESTORE = "none";
const SWAP_UNET = "viggle_remake_swap_pruned_int8_convrot.safetensors";
const H3_CLIP = "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors";
const H3_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors";
const H3_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors";
const EDIT_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const EDIT_LORA = "viggle_remake_edit_comfyui.safetensors";

export class SwapChainError extends Error {
  constructor(message, { status = 500, code = "swap_chain_failed", details } = {}) {
    super(message);
    this.name = "SwapChainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function findBinary(name, config = {}) {
  const key = name === "ffprobe" ? "FFPROBE_PATH" : "FFMPEG_PATH";
  const candidates = [
    process.env[key],
    name,
    config.comfyDir && path.join(config.comfyDir, `${name}.exe`),
    config.comfyDir && path.join(config.comfyDir, "..", `${name}.exe`),
    config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg", "bin", `${name}.exe`),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return "";
}

function ffmpegOrThrow(config) {
  const binary = findBinary("ffmpeg", config);
  if (!binary) throw new SwapChainError("网关未找到 ffmpeg，无法抽帧/生成接触表", { status: 500, code: "ffmpeg_missing" });
  return binary;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function parseBox(value) {
  if (!value) return null;
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch { return null; }
  }
  if (typeof data !== "object") return null;
  const x = clamp01(data.x), y = clamp01(data.y);
  const width = Math.min(1 - x, clamp01(data.width ?? data.w ?? 0.45));
  const height = Math.min(1 - y, clamp01(data.height ?? data.h ?? 0.9));
  if (width < 0.05 || height < 0.05) return null;
  return { x, y, width, height };
}

function inferMode(intent, explicitMode) {
  const allowed = new Set(["single_swap", "double_swap", "edit_clothes", "edit_light", "edit_time"]);
  if (explicitMode && allowed.has(explicitMode)) return explicitMode;
  const text = String(intent || "");
  if (/双人|两人|两个都|同时换|左右都/.test(text)) return "double_swap";
  if (/衣服|服装|西装|换装|外套|裙|领带/.test(text)) return "edit_clothes";
  if (/黄昏|暖光|打光|光照|灯光|光线/.test(text)) return "edit_light";
  if (/夜晚|夜景|黑夜|时间|白天|天色/.test(text)) return "edit_time";
  return "single_swap";
}

// defaultBoxes / targetLabel / buildSinglePrompt 已移到 swap-chain-target.js：
// 原实现里 single_swap 默认取右半幅、提示词说「画面右侧人物」，
// 单人物居中视频会因此换不到人（模型把参考图整个吐出来）。

function buildDoublePrompt(job) {
  return `将画面左侧人物替换为图2中的人物，将画面右侧人物替换为图3中的人物；两人各自保持原姿势、动作、位置、尺度与持杯动作，保持构图、茶具、背景和光照不变；不要串脸、漏换或增加人物。`;
}

function buildEditPrompt(job) {
  const intent = String(job.intent || "").trim();
  if (job.mode === "edit_clothes") return `${intent || "改变右侧人物的服装"}；保持两个人物的身份、脸、发型、姿势、位置、尺度、构图、茶具、背景和光照不变，只改变目标人物的服装。`;
  if (job.mode === "edit_light") return `${intent || "改变场景光照"}；保持人物身份、脸、发型、服装、姿势、位置、尺度、构图和所有物体位置不变，只改变光照。`;
  return `${intent || "把时间改为夜晚"}；保持人物身份、脸、发型、服装、姿势、位置、尺度、构图和所有物体位置不变，只改变时间与夜景光照。`;
}

function buildEditVideoPrompt(job) {
  if (job.mode === "edit_clothes") return buildSwapVideoPrompt({ ...job, mode: "single_swap", targetBoxes: [job.targetBoxes[0] || { x: 0, y: 0, width: 1, height: 1 }] }).replace(/replacement person/g, "target clothing").replace(/character replacement/g, "clothing edit");
  if (job.mode === "edit_light") return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video with the target lighting.\n<Subject 1> is the lighting of the scene: it becomes the lighting in <Picture 1>. All people, clothing, poses and geometry stay as in <Video 1>.\n\nsummary:\n[video editing] Only the lighting changes to match <Picture 1>; people, clothing, poses, objects, camera, motion and timing stay as in <Video 1>.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - people, clothing, poses, objects, camera and timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - lighting only.\n\ndetailed_description:\n[Shot 1] From 00:00.000 to about 00:05.167, the lighting matches <Picture 1>; all people, clothing, poses and object positions stay as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
  return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video at night.\n<Subject 1> is the time of the scene: it becomes night as in <Picture 1>. All people, clothing, poses and geometry stay as in <Video 1>.\n\nsummary:\n[video editing] Only the time and lighting change to night as in <Picture 1>; people, clothing, poses, objects, camera, motion and timing stay as in <Video 1>.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - people, clothing, poses, objects, camera and timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - night time and lighting only.\n\ndetailed_description:\n[Shot 1] From 00:00.000 to about 00:05.167, the scene becomes night with the lighting of <Picture 1>; all people, clothing, poses and object positions stay as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
}

async function runFfmpeg(binary, args, { timeout = 120000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return execFileAsync(binary, args, { timeout, maxBuffer, encoding: null });
}

function fitRemakeFrames(sourceFrameCount) {
  const count = Math.max(REMAKE_FRAMES_MIN, Math.min(REMAKE_FRAMES_MAX, Math.floor(Number(sourceFrameCount) || 0)));
  return alignViggleFramesUp(count);
}

/**
 * 一次 ffprobe 同时取帧数与真实尺寸。
 * 尺寸是必须的：换人画布要按源片短边选，硬编码 480 会把 1080p 压掉一半细节。
 */
async function probeSource(file, config) {
  const empty = { frames: 0, width: 0, height: 0 };
  let binary = findBinary("ffprobe", config);
  if (!binary) {
    try {
      binary = path.join(path.dirname(ffmpegOrThrow(config)), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    } catch {
      return empty;
    }
  }
  const { stdout } = await execFileAsync(binary, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames,duration,avg_frame_rate,width,height", "-show_entries", "format=duration", "-of", "json", file], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  const data = JSON.parse(stdout) || {};
  const stream = data.streams?.[0] || {};
  const width = Number(stream.width) || 0;
  const height = Number(stream.height) || 0;
  const duration = Number(stream.duration) > 0 ? Number(stream.duration) : Number(data.format?.duration);
  if (Number.isFinite(duration) && duration > 0) return { frames: Math.round(duration * 24), width, height };
  const rate = String(stream.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = rate[1] ? rate[0] / rate[1] : rate[0];
  const sourceFrames = Number(stream.nb_frames);
  if (Number.isFinite(sourceFrames) && sourceFrames > 0) {
    return { frames: Number.isFinite(fps) && fps > 0 ? Math.round((sourceFrames * 24) / fps) : Math.round(sourceFrames), width, height };
  }
  return { frames: 0, width, height };
}

async function padSourceToFrames(sourcePath, outputPath, sourceFrameCount, targetFrames, config) {
  const binary = ffmpegOrThrow(config);
  const padSeconds = Math.max(0, (targetFrames - sourceFrameCount) / 24);
  await runFfmpeg(binary, ["-y", "-i", sourcePath, "-vf", `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(6)}`, "-r", "24", "-frames:v", String(targetFrames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", outputPath], { timeout: 120000 });
  return outputPath;
}

async function trimToSourceDuration(inputPath, outputPath, seconds, config) {
  const binary = ffmpegOrThrow(config);
  await runFfmpeg(binary, ["-y", "-i", inputPath, "-t", Number(seconds).toFixed(6), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath], { timeout: 120000 });
  return outputPath;
}

function formatComfyHistoryError(history) {
  const messages = Array.isArray(history?.status?.messages) ? history.status.messages : [];
  const executionError = messages.find((item) => Array.isArray(item) && item[0] === "execution_error")?.[1];
  if (executionError && typeof executionError === "object") {
    const node = [executionError.node_type, executionError.node_id].filter((value) => value !== undefined && value !== null && value !== "").join(" #");
    return `ComfyUI 执行失败${node ? `（${node}）` : ""}：${executionError.exception_message || executionError.exception_type || "未知错误"}`;
  }
  const summary = messages.map((item) => {
    const [event, data] = Array.isArray(item) ? item : [String(item), null];
    if (typeof data === "string") return `${event}:${data}`;
    if (data && typeof data === "object") return `${event}:${data.exception_message || data.message || JSON.stringify(data).slice(0, 300)}`;
    return event;
  }).join("；");
  return `ComfyUI 执行失败：${summary || "未知错误"}`;
}

/**
 * 把一帧缩放到目标画布。
 *
 * 尺寸必须按源片朝向传入（job.imageSize）：写死 832x480 会把竖屏素材
 * 裁成一条横带，人脸整个丢掉。
 */
async function resizeCover(buffer, config, outPath, size = IMAGE_SIZE) {
  const binary = ffmpegOrThrow(config);
  const width = size.width || IMAGE_SIZE.width;
  const height = size.height || IMAGE_SIZE.height;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-resize-"));
  try {
    const input = path.join(tempDir, "input.png");
    await fsp.writeFile(input, buffer);
    await runFfmpeg(binary, ["-y", "-i", input, "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`, "-frames:v", "1", outPath]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function maskImage(buffer, box, config, outPath, size = IMAGE_SIZE) {
  const binary = ffmpegOrThrow(config);
  const width = size.width || IMAGE_SIZE.width;
  const height = size.height || IMAGE_SIZE.height;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-mask-"));
  try {
    const input = path.join(tempDir, "input.png");
    await fsp.writeFile(input, buffer);
    const x = Math.round(box.x * width);
    const y = Math.round(box.y * height);
    const w = Math.max(8, Math.round(box.width * width));
    const h = Math.max(8, Math.round(box.height * height));
    await runFfmpeg(binary, ["-y", "-i", input, "-vf", `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.7:t=fill`, "-frames:v", "1", outPath]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function rgbGrid(buffer, config) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-grid-"));
  try {
    const input = path.join(tempDir, "input.png");
    await fsp.writeFile(input, buffer);
    const { stdout } = await runFfmpeg(binary, ["-v", "error", "-i", input, "-vf", "scale=64:36", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function inBox(x, y, box) {
  return x + 0.5 >= box.x * 64 && x + 0.5 < (box.x + box.width) * 64 && y + 0.5 >= box.y * 36 && y + 0.5 < (box.y + box.height) * 36;
}

/**
 * 区域内差异的「局部峰值」：取差异最大的前 5% 格子的均值。
 *
 * 为什么需要它：换人只改脸，脸在整幅画面里只占十几个百分点。
 * 现场实测（脸已完全换掉）：整图平均差异 5.47，前 5% 格子均值 54.33。
 * 用整图平均判定会把改动按面积稀释，必然误杀。
 */
/**
 * 区域内单格最大差异：给「精细换脸」用的兜底口径。
 *
 * ReActor/inswapper 只替换五官纹理，改动面积很小（实测差异>10 的格子仅占 3%），
 * 但单点幅度明确（最大 23.67）。只看前 5% 均值（11.61）会漏判。
 */
function maxRegionDiff(a, b, boxes) {
  let max = 0;
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      if (!boxes.some((box) => inBox(x, y, box))) continue;
      const px = (y * 64 + x) * 3;
      const d = (Math.abs(a[px] - b[px]) + Math.abs(a[px + 1] - b[px + 1]) + Math.abs(a[px + 2] - b[px + 2])) / 3;
      if (d > max) max = d;
    }
  }
  return max;
}

function peakRegionDiff(a, b, boxes, ratio = 0.05) {
  const diffs = [];
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const px = (y * 64 + x) * 3;
      if (!boxes.some((box) => inBox(x, y, box))) continue;
      const d = Math.abs(a[px] - b[px]) + Math.abs(a[px + 1] - b[px + 1]) + Math.abs(a[px + 2] - b[px + 2]);
      diffs.push(d / 3);
    }
  }
  if (!diffs.length) return 0;
  diffs.sort((left, right) => right - left);
  const take = Math.max(1, Math.floor(diffs.length * ratio));
  const head = diffs.slice(0, take);
  return head.reduce((sum, value) => sum + value, 0) / head.length;
}

function regionDiff(a, b, boxes, { inside = true } = {}) {
  let sum = 0, count = 0;
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const px = (y * 64 + x) * 3;
      const match = boxes.some((box) => inBox(x, y, box));
      if ((inside && !match) || (!inside && match)) continue;
      sum += Math.abs(a[px] - b[px]) + Math.abs(a[px + 1] - b[px + 1]) + Math.abs(a[px + 2] - b[px + 2]);
      count += 3;
    }
  }
  return count ? sum / count : 0;
}

function histogram(buffer) {
  const bins = new Float64Array(64);
  for (let i = 0; i < buffer.length; i += 3) {
    const r = Math.min(3, Math.floor(buffer[i] / 64));
    const g = Math.min(3, Math.floor(buffer[i + 1] / 64));
    const b = Math.min(3, Math.floor(buffer[i + 2] / 64));
    bins[(r << 4) | (g << 2) | b] += 1;
  }
  const total = bins.reduce((sum, value) => sum + value, 0) || 1;
  return Array.from(bins, (value) => value / total);
}

/**
 * 逐像素相关性：真正反映「是不是同一张构图」。
 *
 * 与 histCorr 的区别：直方图相关只看颜色分布，冷色调海景和冷色调西装近景
 * 会被判成「相似」；逐像素相关比较同一坐标上的颜色，构图一变就掉下来。
 */
function pixelCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - meanA;
    const y = b[i] - meanB;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function histCorr(a, b) {
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - meanA, y = b[i] - meanB;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function cropGrid(grid, box) {
  const out = Buffer.alloc(grid.length);
  let index = 0;
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      if (!inBox(x, y, box)) continue;
      const px = (y * 64 + x) * 3;
      out[index++] = grid[px]; out[index++] = grid[px + 1]; out[index++] = grid[px + 2];
    }
  }
  return out.subarray(0, index);
}

async function evaluateImageGate(job, paintedBuffer, config) {
  const source = await fsp.readFile(job.paths.target);
  const targetGrid = await rgbGrid(source, config);
  const paintedGrid = await rgbGrid(paintedBuffer, config);
  const boxes = job.targetBoxes.length ? job.targetBoxes : [{ x: 0, y: 0, width: 1, height: 1 }];
  const outsideDiff = regionDiff(targetGrid, paintedGrid, boxes, { inside: false });
  const targetDiff = regionDiff(targetGrid, paintedGrid, boxes, { inside: true });
  const identity = [];
  for (let i = 0; i < Math.min(job.refs.length, boxes.length); i += 1) {
    const refGrid = await rgbGrid(await fsp.readFile(job.paths.refs[i]), config);
    const refHist = histogram(refGrid);
    const paintedHist = histogram(cropGrid(paintedGrid, boxes[i]));
    const sourceHist = histogram(cropGrid(targetGrid, boxes[i]));
    const paintedCorr = histCorr(refHist, paintedHist);
    const sourceCorr = histCorr(refHist, sourceHist);
    const delta = paintedCorr - sourceCorr;
    identity.push({ ref: job.refNames[i], paintedCorr: Number(paintedCorr.toFixed(4)), sourceCorr: Number(sourceCorr.toFixed(4)), delta: Number(delta.toFixed(4)), hit: delta >= -0.03, inconclusive: Math.abs(delta) < 0.02 });
  }
  const isEdit = job.mode.startsWith("edit_");
  // 整幅框时「框外」是空集合，regionDiff 返回 0，outsideOk 会恒真 ——
  // 这样「框外必须不变」这条约束等于没有，只要画面整体变了就算过。
  // 现场后果：一张被裁成领带特写的图（根本没有人脸）也能通过图像门，
  // 错误只被推到最后的视频门才发现，白烧一次视频生成。
  //
  // 兜底：整幅框时改用「逐像素结构相关性」作为约束。
  //
  // 这里不能用直方图相关性 —— 它只看颜色分布、不看空间位置。现场踩过：
  // 模型把「西装男近景」重画成「古风人物在海面旋涡中施法」，两者都是低饱和
  // 冷色调，直方图相关高达 0.7807，被误判为「结构保持」放行，而逐像素相关
  // 只有 0.3658 —— 构图早就崩了。白烧一次 30 分钟的视频生成。
  //
  // 阈值取 0.55：正常换人（只改人脸）实测在 0.80 以上，整图重画在 0.37 左右，
  // 中间留足余量。
  const fullFrame = boxes.every((box) => isFullFrameBox(box));
  const structureCorr = fullFrame ? pixelCorr(targetGrid, paintedGrid) : 1;
  // 局部峰值差异：换人只改脸，脸在整幅画面里占比很小，
  // 用整图平均会把改动稀释到阈值以下（实测整图 5.47 vs 前5%格子 54.33）。
  const peakDiff = peakRegionDiff(targetGrid, paintedGrid, boxes);
  // 最大单格差异：ReActor 这类精细换脸只改五官纹理，改动面积小（差异>10 的
  // 格子仅占 3%），但单点幅度明确 —— 实测最大 23.67，而峰值均值只有 11.61。
  const maxDiff = maxRegionDiff(targetGrid, paintedGrid, boxes);
  // 判定细节见 swap-chain-target.js 的 judgeImageGate。
  const verdict = judgeImageGate({
    outsideDiff,
    targetDiff,
    peakDiff,
    maxDiff,
    structureCorr,
    fullFrame,
    mode: job.mode,
    identity,
  });
  const { outsideOk, changedOk, identityOk, pass } = verdict;
  const negativeGrid = targetGrid;
  const negativeDiff = regionDiff(targetGrid, negativeGrid, boxes, { inside: true });
  return {
    method: "rgb64x36-proxy (no face embedding); identity is advisory, target-hit is enforced by targetDiff/outsideDiff",
    identityAdvisory: true,
    outsideDiff: Number(outsideDiff.toFixed(2)),
    targetDiff: Number(targetDiff.toFixed(2)),
    peakDiff: Number(peakDiff.toFixed(2)),
    maxDiff: Number(maxDiff.toFixed(2)),
    fullFrame,
    structureCorr: Number(structureCorr.toFixed(4)),
    identity,
    outsideOk,
    changedOk,
    peakOk: verdict.peakOk ?? null,
    avgOk: verdict.avgOk ?? null,
    maxOk: verdict.maxOk ?? null,
    identityOk,
    negativeControl: { name: "unchanged-target", targetDiff: Number(negativeDiff.toFixed(2)), wouldPass: negativeDiff > 7 },
    pass,
  };
}

async function evaluateVideoGate(job, videoBuffer, config) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-vgate-"));
  try {
    const videoPath = path.join(tempDir, "output.mp4");
    await fsp.writeFile(videoPath, videoBuffer);
    const source = { buffer: await fsp.readFile(job.paths.source), originalname: "source.mp4" };
    const frames = [0, 32, 64, 96];
    const outputFrames = [];
    const sourceFrames = [];
    for (const frame of frames) {
      outputFrames.push(await extractVideoFrame({ buffer: videoBuffer, originalname: "output.mp4" }, { frame, config }));
      sourceFrames.push(await extractVideoFrame(source, { frame, config }));
    }
    const boxes = job.targetBoxes.length ? job.targetBoxes : [{ x: 0.04, y: 0.03, width: 0.92, height: 0.94 }];
    const readings = [];
    for (let i = 0; i < frames.length; i += 1) {
      const outGrid = await rgbGrid(outputFrames[i].buffer, config);
      const srcGrid = await rgbGrid(sourceFrames[i].buffer, config);
      const targetDiff = regionDiff(srcGrid, outGrid, boxes, { inside: true });
      const outsideDiff = regionDiff(srcGrid, outGrid, boxes, { inside: false });
      // 逐帧换脸（ReActor）只改五官，改动面积小、整图平均会被稀释。
      // 所以额外记录局部峰值与单格最大值，供 keep_clothes 模式判定用。
      const peakDiff = peakRegionDiff(srcGrid, outGrid, boxes);
      const maxDiff = maxRegionDiff(srcGrid, outGrid, boxes);
      let luma = 0;
      for (let p = 0; p < outGrid.length; p += 3) luma += outGrid[p] * 0.299 + outGrid[p + 1] * 0.587 + outGrid[p + 2] * 0.114;
      luma /= outGrid.length / 3;
      readings.push({ frame: frames[i], targetDiff: Number(targetDiff.toFixed(2)), peakDiff: Number(peakDiff.toFixed(2)), maxDiff: Number(maxDiff.toFixed(2)), outsideDiff: Number(outsideDiff.toFixed(2)), luma: Number(luma.toFixed(1)) });
    }
    // 判定细节（含「第 0 帧不参与门槛」的理由）见 swap-chain-target.js 的 judgeVideoGate。
    const verdict = judgeVideoGate({ readings, mode: job.mode });
    const unchanged = { frame: 0, targetDiff: 0, outsideDiff: 0, luma: 0 };
    return {
      method: "rgb64x36-proxy (no face embedding)",
      samples: readings,
      targetMin: verdict.targetMin,
      startDiff: verdict.startDiff,
      outsideMax: verdict.outsideMax,
      backgroundMax: verdict.backgroundMax,
      lumaMin: verdict.lumaMin,
      targetOk: verdict.targetOk,
      backgroundOk: verdict.backgroundOk,
      blackOk: verdict.blackOk,
      negativeControl: { name: "unchanged-source", targetDiff: unchanged.targetDiff, wouldPass: unchanged.targetDiff > 6 },
      pass: verdict.pass,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function makeContactSheet(videoBuffer, config, outPath) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-contact-"));
  try {
    const input = path.join(tempDir, "output.mp4");
    await fsp.writeFile(input, videoBuffer);
    await runFfmpeg(binary, ["-y", "-i", input, "-vf", "select='not(mod(n\\,8))',scale=240:-1,tile=4x4", "-frames:v", "1", outPath], { timeout: 120000 });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 逐帧换脸视频：把 ReActor 应用在整段视频的每一帧上。
 *
 * 为什么不能只换图像段的那一帧：
 * 实测 keep_clothes 只在图像段换脸时，painted 的脸部改动只有纹理级
 * （maxDiff 23.67，差异>10 的格子仅 3%），视频段的 H3 Remake 认为它
 * 与原片几乎一致，于是把脸"还原"成原来的样子 —— 出片里人脸根本没换。
 *
 * 正确做法：视频段照常用原片源（保服装/动作/背景），
 * 出片后再逐帧跑 ReActor，这样脸才真的换掉，衣服也真的不动。
 */
function reactorVideoSwapGraph(job, names, { fps = 24, prefix }) {
  const graph = {
    "1": { class_type: "VHS_LoadVideoPath", inputs: {
      video: names.video,
      force_rate: 0,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
      format: "AnimateDiff",
    } },
    "2": { class_type: "LoadImage", inputs: { image: names.ref } },
    "3": { class_type: "ReActorFaceSwap", inputs: {
      enabled: true,
      input_image: ["1", 0],
      source_image: ["2", 0],
      swap_model: "inswapper_128.onnx",
      facedetection: "retinaface_resnet50",
      face_restore_model: REACTOR_RESTORE,
      face_restore_visibility: 1,
      codeformer_weight: 0.5,
      detect_gender_input: "no",
      detect_gender_source: "no",
      input_faces_index: "0",
      source_faces_index: "0",
      console_log_level: 0,
    } },
    "4": { class_type: "VHS_VideoCombine", inputs: {
      images: ["3", 0],
      frame_rate: fps,
      loop_count: 0,
      filename_prefix: prefix,
      format: "video/h264-mp4",
      pingpong: false,
      save_output: true,
      // 保留原片音轨：换脸不该改变声音
      audio: ["1", 2],
    } },
  };
  return graph;
}

function imageGraph(job, names) {
  const single = job.mode === "single_swap";
  const double = job.mode === "double_swap";
  const refs = names.refs;
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: QWEN_UNET, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: QWEN_LORA_6, strength_model: 1 } },
    "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: QWEN_OLDX, strength_model: single ? 0.9 : 0 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: QWEN_CLIP, type: "qwen_image", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: QWEN_VAE } },
    "6": { class_type: "LoadImage", inputs: { image: names.target } },
    "10": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["4", 0], vae: ["5", 0], negative_prompt: "extra fingers, missing fingers, deformed hands, bad anatomy, malformed hands", resolution: 1024 } },
    "11": { class_type: "VAEEncode", inputs: { pixels: ["6", 0], vae: ["5", 0] } },
    "12": { class_type: "CFGGuider", inputs: { model: ["3", 0], positive: ["10", 0], negative: ["10", 1], cfg: 1 } },
    "13": { class_type: "RandomNoise", inputs: { noise_seed: job.seed } },
    "14": { class_type: "ManualSigmas", inputs: { sigmas: QWEN_SIGMAS } },
    "15": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["15", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["5", 0] } },
    "18": { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: `swap-chain/${job.id}/painted` } },
  };
  if (single) {
    graph["10"].inputs["images.image_1"] = ["7", 0];
    graph["10"].inputs["images.image_2"] = ["6", 0];
    graph["10"].inputs.prompt = buildSingleSwapPrompt(job.targetBoxes[0]);
  } else if (double) {
    graph["10"].inputs["images.image_1"] = ["6", 0];
    graph["10"].inputs["images.image_2"] = ["7", 0];
    graph["10"].inputs["images.image_3"] = ["8", 0];
    graph["10"].inputs.prompt = buildDoublePrompt(job);
  } else {
    graph["10"].inputs["images.image_1"] = ["6", 0];
    graph["10"].inputs.prompt = buildEditPrompt(job);
  }
  for (let i = 0; i < Math.min(refs.length, 2); i += 1) {
    graph[String(7 + i)] = { class_type: "LoadImage", inputs: { image: refs[i] } };
  }
  return graph;
}

function swapVideoGraph(job, names) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: SWAP_UNET, weight_dtype: "default" } },
    "21": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["1", 0], shift_video: 12, shift_audio: 2 } },
    "22": { class_type: "ModelAttentionBackend", inputs: { model: ["21", 0], attention: "comfy kitchen attention" } },
    "23": { class_type: "ModelPreviewOverrideKJ", inputs: { model: ["22", 0], max_resolution: 1024, jpeg_quality: 80, suppress_default_preview: true, preview_frames: 1024, preview_fps: 12, tiny_vae: "taeh3.safetensors" } },
    "24": { class_type: "BlockSparseAttention", inputs: { model: ["23", 0], selection: "sol-attn", "selection.tau": 1.1, start_percent: 0.2, end_percent: 1, dense_blocks: "", min_tokens: 12288, extra_tokens: 256, sink_conditioning: "exact_kv_and_rows", verbose: false } },
    "3": { class_type: "RemakeKeyframeUntil", inputs: { model: ["24", 0], keyframe_until: 0.9 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: H3_CLIP, type: "minimax", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: H3_VIDEO_VAE } },
    "6": { class_type: "VAELoader", inputs: { vae_name: H3_AUDIO_VAE } },
    // TensorRT 版视频 VAE 解码器：引擎文件已随包提供，解码比 torch 路径快得多。
    // 注意 RemakeConditioning 仍要用原始 VAE（节点 5）做编码 —— TRT 只替换解码。
    "91": { class_type: "MiniMaxH3TRTVAELoader", inputs: { decoder: "minimax_h3_vae_decoder.engine", encoder: "None" } },
    "9": { class_type: "LoadImage", inputs: { image: names.painted } },
    "9102": { class_type: "VHS_LoadVideo", inputs: { video: names.source, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 345, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } },
    "42": { class_type: "RemakeConditioning", inputs: { clip: ["4", 0], vae: ["5", 0], audio_vae: ["6", 0], source: ["9102", 0], prompt: buildSwapVideoPrompt(job), ref_1: ["9", 0], pins: "", frames: job.frames || FRAMES, short_edge: job.shortEdge || DEFAULT_SHORT_EDGE, audio: ["9102", 2] } },
    "12": { class_type: "RemakeNoise", inputs: { positive: ["42", 0], seed: job.seed } },
    "13": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["42", 0] } },
    "14": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "15": { class_type: "ManualSigmas", inputs: { sigmas: SWAP_SIGMAS } },
    "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["13", 0], sampler: ["14", 0], sigmas: ["15", 0], latent_image: ["42", 1] } },
    // 一次 AVDecodeT8 同时解出画面与音频（原来要 VAEDecode + VAEDecodeAudio 两次），
    // 视频走 TensorRT 引擎，音频仍用原始音频 VAE。
    "17": { class_type: "MiniMaxH3AVDecodeT8", inputs: { av_latent: ["16", 0], video_vae: ["91", 0], audio_vae: ["6", 0] } },
    "19": { class_type: "CreateVideo", inputs: { images: ["17", 0], audio: ["17", 1], fps: 24, bit_depth: "auto", color_space: "sRGB", codec: "none" } },
    "20": { class_type: "SaveVideo", inputs: { video: ["19", 0], filename_prefix: `swap-chain/${job.id}/video`, format: "mp4", codec: "h264" } },
  };
}

function editVideoGraph(job, names) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: EDIT_UNET, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderBypassModelOnly", inputs: { model: ["1", 0], lora_name: EDIT_LORA, strength_model: 1 } },
    "3": { class_type: "RemakeKeyframeUntil", inputs: { model: ["2", 0], keyframe_until: 0.9 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: H3_CLIP, type: "minimax", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: H3_VIDEO_VAE } },
    "6": { class_type: "VAELoader", inputs: { vae_name: H3_AUDIO_VAE } },
    "7": { class_type: "VHS_LoadVideo", inputs: { video: names.source, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 345, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } },
    "8": { class_type: "LoadImage", inputs: { image: names.painted } },
    "30": { class_type: "PathchSageAttentionKJ", inputs: { model: ["3", 0], sage_attention: "auto", allow_compile: false } },
    "9": { class_type: "RemakeConditioning", inputs: { clip: ["4", 0], vae: ["5", 0], audio_vae: ["6", 0], source: ["7", 0], ref_1: ["8", 0], pins: "", frames: job.frames || FRAMES, short_edge: job.shortEdge || DEFAULT_SHORT_EDGE, prompt: buildEditVideoPrompt(job), audio: ["7", 2] } },
    "10": { class_type: "RemakeNoise", inputs: { positive: ["9", 0], seed: job.seed } },
    "11": { class_type: "BasicGuider", inputs: { model: ["30", 0], conditioning: ["9", 0] } },
    "12": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "13": { class_type: "ManualSigmas", inputs: { sigmas: EDIT_SIGMAS } },
    "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["11", 0], sampler: ["12", 0], sigmas: ["13", 0], latent_image: ["9", 1] } },
    "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["5", 0] } },
    "16": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["6", 0] } },
    "17": { class_type: "CreateVideo", inputs: { images: ["15", 0], audio: ["16", 0], fps: 24, bit_depth: "auto", color_space: "sRGB", codec: "none" } },
    "18": { class_type: "SaveVideo", inputs: { video: ["17", 0], filename_prefix: `swap-chain/${job.id}/video`, format: "mp4", codec: "h264" } },
  };
}

export function createSwapChain({ comfy, config, logger, dataDir, comfyRoot = () => "" }) {
  const root = path.join(dataDir, "swap-chain");
  const storeFile = path.join(dataDir, "swap-chain-jobs.json");
  fs.mkdirSync(root, { recursive: true });
  let jobs = new Map();
  let loaded = false;
  let activeJobId = null;
  const queue = [];

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (fs.existsSync(storeFile)) {
        const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
        for (const job of data.jobs || []) {
          if (job.status === "running" || job.status === "queued") {
            job.status = "interrupted";
            job.error = "网关重启导致任务中断；可点击重试从图像阶段继续";
            job.updatedAt = new Date().toISOString();
          }
          jobs.set(job.id, job);
        }
      }
    } catch (error) {
      logger?.warn?.(`swap-chain job 存储读取失败：${error.message}`);
    }
  }

  function save() {
    writeJsonAtomic(storeFile, { version: 1, updatedAt: new Date().toISOString(), jobs: [...jobs.values()] });
  }

  function publicJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      mode: job.mode,
      intent: job.intent,
      targetBoxes: job.targetBoxes,
      seed: job.seed,
      // 是否保留了原片服装（true=只换脸，ReActor 路径）
      keepClothes: Boolean(job.keepClothes),
      keepClothesSkipped: job.keepClothesSkipped || null,
      sourceFrameCount: job.sourceFrameCount ?? null,
      frames: job.frames ?? null,
      // 源片真实尺寸与选定的画布短边：前端可据此提前告知「会输出多大」，
      // 也便于排查「为什么出片不是原分辨率」。
      sourceSize: job.sourceSize || null,
      shortEdge: job.shortEdge ?? null,
      promptIds: job.promptIds,
      gates: job.gates,
      error: job.error || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      artifacts: {
        video: `/v1/swap-chain/${job.id}/content/video`,
        painted: `/v1/swap-chain/${job.id}/content/painted`,
        target: `/v1/swap-chain/${job.id}/content/target`,
        contact: `/v1/swap-chain/${job.id}/content/contact`,
      },
    };
  }

  function jobDir(id) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function update(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    save();
  }

  async function create({ source, refs = [], intent = "", mode, targetSelection, seed, keepClothes = false }) {
    load();
    if (!source?.buffer?.length) throw new SwapChainError("缺少源视频", { status: 400, code: "missing_source_video" });
    const selectedMode = inferMode(intent, mode);
    if (selectedMode === "double_swap" && refs.length < 2) throw new SwapChainError("双人替换需要 2 张参考图", { status: 400, code: "missing_reference" });
    if (selectedMode !== "double_swap" && selectedMode.endsWith("_swap") && !refs.length) throw new SwapChainError("换人需要至少 1 张参考图", { status: 400, code: "missing_reference" });
    const parsed = parseBox(targetSelection);
    const explicitBoxes = Array.isArray(targetSelection?.boxes) ? targetSelection.boxes.map(parseBox).filter(Boolean) : [];
    const boxes = explicitBoxes.length ? explicitBoxes : parsed ? [parsed] : defaultTargetBoxes(selectedMode, intent);
    const id = randomId("swap_");
    const dir = jobDir(id);
    await fsp.writeFile(path.join(dir, "source.mp4"), source.buffer);
    const refNames = [];
    const refPaths = [];
    for (let i = 0; i < refs.length; i += 1) {
      const name = `ref-${i}.png`;
      await fsp.writeFile(path.join(dir, name), refs[i].buffer);
      refNames.push(name);
      refPaths.push(path.join(dir, name));
    }
    const job = {
      id, mode: selectedMode, intent: String(intent || "").trim(), targetBoxes: boxes,
      seed: Number(seed) || DEFAULT_SEED,
      // 是否保留原片服装。默认 false（沿用旧行为：参考图的长相与服装一起带过来）。
      keepClothes: Boolean(keepClothes),
      status: "queued", stage: "s1_intent", progress: 0,
      refs: refs.map((item, index) => ({ name: refNames[index], filename: item.originalname || refNames[index], mimeType: item.mimetype || "image/png" })),
      refNames, paths: { dir, source: path.join(dir, "source.mp4"), target: path.join(dir, "target.png"), masked: path.join(dir, "target-masked.png"), painted: path.join(dir, "painted.png"), video: path.join(dir, "video.mp4"), contact: path.join(dir, "contact.png"), refs: refPaths },
      promptIds: [], gates: {}, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    jobs.set(id, job);
    save();
    queue.push(id);
    pump();
    return publicJob(job);
  }

  function fail(job, error) {
    if (!job) return;
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.stage = job.stage || "unknown";
    job.error = error?.message || String(error);
    job.errorCode = error?.code || "swap_chain_failed";
    job.updatedAt = new Date().toISOString();
    save();
    logger?.warn?.(`swap-chain ${job.id} failed at ${job.stage}: ${job.error}`);
  }

  /**
   * prompt 是否还「活着」（在队列里或正在执行）。
   * 查不到队列信息时返回 true，避免因为接口异常误判任务丢失。
   */
  async function isPromptAlive(promptId) {
    const data = await comfy.queue().catch(() => null);
    // 判定细节见 swap-chain-target.js 的 isPromptInQueue。
    return isPromptInQueue(data, promptId);
  }

  async function waitPrompt(job, graph, { stage, timeoutMs = 15 * 60 * 1000 }) {
    const submitted = await comfy.submit(graph, { clientId: `swap-chain-${job.id}`, signal: undefined });
    job.promptIds.push({ stage, promptId: submitted.promptId });
    update(job, {});
    const deadline = Date.now() + timeoutMs;
    // 连续查不到历史记录时要区分两种情况：
    //   · 任务在队列里正常等待/执行 —— 继续等
    //   · 任务既不在队列也不在历史 —— 已经被 ComfyUI 丢掉了，再等也不会好
    // 现场踩过：/view 坏掉期间任务看起来「卡在 s5_video」其实早已结束，
    // 而现在这个循环会一直空转到超时，用户只能干等。
    let missingStreak = 0;
    while (Date.now() < deadline) {
      if (job.cancelRequested) {
        await comfy.interrupt(submitted.promptId).catch(() => {});
        throw new SwapChainError("任务已取消", { status: 499, code: "cancelled" });
      }
      await sleep(2000);
      const history = await comfy.history(submitted.promptId).catch(() => null);
      if (!history) {
        missingStreak += 1;
        // 连续 30 次（约 1 分钟）查不到，再确认一次它是否还在队列里。
        if (missingStreak >= 30) {
          const stillQueued = await isPromptAlive(submitted.promptId).catch(() => true);
          if (!stillQueued) {
            throw new SwapChainError(
              `ComfyUI 里找不到这次任务（${stage}），可能已被中断或服务重启。请重试。`,
              { status: 502, code: "comfy_prompt_lost" },
            );
          }
          missingStreak = 0;
        }
        continue;
      }
      missingStreak = 0;
      if (history.status?.status_str === "error") throw new SwapChainError(formatComfyHistoryError(history), { status: 502, code: "comfy_failed" });
      if (history.outputs && Object.keys(history.outputs).length) return { history, promptId: submitted.promptId };
    }
    await comfy.interrupt(submitted.promptId).catch(() => {});
    // 说清楚是哪个阶段、等了多久：用户看到「执行超时」不知道是模型慢还是卡死。
    const minutes = Math.round(timeoutMs / 60000);
    throw new SwapChainError(
      `ComfyUI 生成超时（${stage} 已等待 ${minutes} 分钟）。视频阶段通常需要 10-20 分钟，` +
        `若 ComfyUI 刚启动还需先加载模型权重；可稍后重试。`,
      { status: 504, code: "comfy_timeout" },
    );
  }

  function outputFile(history) {
    for (const output of Object.values(history.outputs || {})) {
      for (const key of ["images", "gifs", "videos"]) {
        const file = output?.[key]?.[0];
        if (file?.filename) return file;
      }
    }
    return null;
  }

  async function upload(buffer, name, mimeType) {
    return comfy.uploadImage(buffer, name, mimeType);
  }

  function pump() {
    if (activeJobId) return;
    while (queue.length) {
      const id = queue.shift();
      const next = jobs.get(id);
      if (!next || next.status !== "queued") continue;
      activeJobId = id;
      run(next).finally(() => { activeJobId = null; pump(); });
      return;
    }
  }

  async function prepareStage(job, stage) {
    await comfy.freeMemory().catch((error) => logger?.warn?.(`swap-chain /free 失败：${error.message}`));
    const stats = await comfy.systemStats().catch(() => null);
    const device = stats?.devices?.[0];
    const freeMb = device?.vram_free ? Math.round(Number(device.vram_free) / (1024 * 1024)) : 0;
    job.vram = { ...(job.vram || {}), [stage]: freeMb };
    update(job, {});
  }

  async function run(job) {
    load();
    if (job.status === "cancelled") return;
    job.status = "running";
    job.cancelRequested = false;
    update(job, { stage: "s2_frame", progress: 8 });
    try {
      const source = { buffer: await fsp.readFile(job.paths.source), originalname: "source.mp4" };
      let probe = { frames: 0, width: 0, height: 0 };
      try {
        probe = await probeSource(job.paths.source, config);
      } catch (error) {
        logger?.warn?.(`swap-chain 源片探测失败：${error.message}`);
      }
      const sourceFrameCount = probe.frames;
      job.sourceFrameCount = sourceFrameCount;
      job.frames = sourceFrameCount > 0 ? fitRemakeFrames(sourceFrameCount) : FRAMES;
      // 画布短边按源片真实尺寸选，不再硬编码 480：
      // 1080p 源片用 480 会把细节砍掉一半，720p 用 480 也会损失比例。
      job.shortEdge = pickRemakeShortEdge(probe.width, probe.height);
      job.sourceSize = { width: probe.width, height: probe.height };
      // 图像画布按源片朝向算：竖屏素材若按横屏裁，会把人脸裁掉。
      job.imageSize = pickImageCanvas(probe.width, probe.height);
      update(job, {});
      let frame = await extractVideoFrame(source, { frame: 0, config });
      let score = null;
      try {
        const scored = await scoreVideoFrames([frame], { config, references: job.refs.map((_item, index) => ({ buffer: fs.readFileSync(job.paths.refs[index]) })) });
        score = scored[0] || null;
        if (score?.black) {
          frame = await extractVideoFrame(source, { frame: 64, config });
          score = { ...(score || {}), fallback: "first-frame-black" };
        }
      } catch { /* 选帧打分为可选，失败仍用首帧 */ }
      job.frame = frame.frame;
      job.frameScore = score ? { score: score.score, similarity: score.similarity, black: score.black, fallback: score.fallback } : null;
      await resizeCover(frame.buffer, config, job.paths.target, job.imageSize);
      // 遮罩只对「局部区域」有意义。
      //
      // 现场事故：single_swap 的默认框改成了整幅 (0,0,1,1) 之后，这里仍然
      // 按框涂黑 —— 等于把整张底图压暗 70%。模型收到一张几乎全黑的图，
      // 又被要求「保持背景不变」，于是干脆重画了一整张（实测产出「古风人物
      // 在海面旋涡中施法」，与原片的西装近景毫无关系），再送去做视频就出现
      // 了从领带变成钢铁侠反应堆的离谱过渡。
      //
      // 整幅框时保留原图：换人靠 prompt 与 LoRA 引导，底图必须完整可见。
      const fullFrameTarget = job.targetBoxes.length === 1 && isFullFrameBox(job.targetBoxes[0]);
      if (job.mode === "single_swap" && !fullFrameTarget) {
        await maskImage(await fsp.readFile(job.paths.target), job.targetBoxes[0], config, job.paths.masked, job.imageSize);
      } else {
        await fsp.copyFile(job.paths.target, job.paths.masked);
      }
      const targetImage = await upload(await fsp.readFile(job.paths.masked), "swap-target.png", "image/png");
      const refImages = [];
      for (let i = 0; i < job.paths.refs.length; i += 1) {
        refImages.push(await upload(await fsp.readFile(job.paths.refs[i]), `swap-ref-${i}.png`, "image/png"));
      }
      let painted = null;
      let imageGate = null;
      // keep_clothes=true：只换脸不动服装。
      // 只有单人换脸支持这种模式（双人/编辑类仍走 Qwen 全图重绘）。
      const keepClothes = Boolean(job.keepClothes) && job.mode === "single_swap" && refImages.length > 0;
      if (job.keepClothes && !keepClothes) {
        job.keepClothesSkipped = "ReActor 只在单人换脸时可用，本次已回退到整体重绘";
      }
      // keep_clothes 模式下整段图像制备都不需要：
      // 最终画面由「源视频逐帧换脸」直接产出，先在这里生成一张 painted 只会在
      // 磁盘上留一个用不上的中间文件，还白烧一次图像生成。
      if (!keepClothes) {
      await prepareStage(job, "s3_image");
      update(job, { stage: "s3_image", progress: 20 });
      for (let attempt = 0; attempt <= MAX_IMAGE_RETRIES; attempt += 1) {
        const graph = imageGraph(job, { target: targetImage.name, refs: refImages.map((item) => item.name) });
        if (attempt > 0) {
          const node = graph["10"];
          node.inputs.prompt = `${node.inputs.prompt} 目标区域之外保持完全不变；只替换指定目标人物。`;
          graph["13"].inputs.noise_seed = job.seed + attempt;
        }
        const { history, promptId } = await waitPrompt(job, graph, { stage: `s3_image_${attempt}` });
        const file = outputFile(history);
        if (!file) throw new SwapChainError("图像制备没有输出", { status: 502, code: "image_no_output" });
        const view = await comfy.view(file);
        painted = view.buffer;
        await fsp.writeFile(job.paths.painted, painted);
        update(job, { stage: "s4_image_gate", progress: 35 });
        imageGate = await evaluateImageGate(job, painted, config);
        job.gates.image = { ...imageGate, attempt, promptId };
        update(job, {});
        if (imageGate.pass) break;
      }
      if (!imageGate?.pass) throw new SwapChainError("图像门未通过：目标未命中/身份或背景保持不足", { status: 422, code: "image_gate_failed", details: imageGate });
      }
      let paintedImage = null;
      if (!keepClothes) {
        await prepareStage(job, "s5_video");
        update(job, { stage: "s5_video", progress: 45 });
        paintedImage = await upload(painted, "swap-painted.png", "image/png");
      }
      let videoSourcePath = job.paths.source;
      if (job.sourceFrameCount > 0 && job.frames > job.sourceFrameCount) {
        try {
          videoSourcePath = await padSourceToFrames(job.paths.source, path.join(job.paths.dir, "source-padded.mp4"), job.sourceFrameCount, job.frames, config);
          job.paddedSource = videoSourcePath;
          update(job, {});
        } catch (error) {
          throw new SwapChainError(`源视频补帧失败：${error.message}`, { status: 500, code: "source_pad_failed" });
        }
      }
      const sourceVideo = await upload(await fsp.readFile(videoSourcePath), "swap-source.mp4", "video/mp4");
      // keep_clothes 模式：H3 段改为「用原片自身体做参考」，只做轻度重建来保动作
      // 与服装；真正换脸放到出片之后逐帧跑 ReActor。
      //
      // 原因：ReActor 在单帧上的改动是纹理级的（maxDiff 23.67、差异>10 的格子仅
      // 3%），H3 Remake 面对这种细微变化会认为「和原片一样」，直接把脸还原回去，
      // 实测出片里人脸根本没换。所以脸必须在最终画面上换。
      let video = null;
      let videoGate = null;

      // keep_clothes 模式：完全跳过 H3 视频重绘，直接在源视频上逐帧换脸。
      //
      // 为什么不能先让 H3 生成再换脸：H3 的参考图若用原片自身，等于让它照着
      // 原片重画一遍 —— 实测产出与原片逐帧相关 0.9997（几乎是原样复刻），
      // 白烧约 5 分钟，还会多产出一份和原片几乎一样的中间文件。
      // 既然「服装/动作/背景全都不动」，就根本不需要重绘，直接换脸。
      if (keepClothes) {
        await prepareStage(job, "s5_face_swap");
        update(job, { stage: "s5_face_swap", progress: 45 });
        const swapRef = await upload(await fsp.readFile(job.paths.refs[0]), `face-swap-ref-${job.id}.png`, "image/png");
        // VHS_LoadVideoPath 只认磁盘绝对路径：直接用源视频本地路径，不用上传。
        const sourceAbs = path.resolve(job.paths.source);
        if (!fs.existsSync(sourceAbs)) {
          throw new SwapChainError(`找不到源视频：${sourceAbs}`, { status: 500, code: "face_swap_source_missing" });
        }
        const fg = reactorVideoSwapGraph(
          job,
          { video: sourceAbs, ref: swapRef.name },
          { fps: 24, prefix: `swap-chain/${job.id}/video` },
        );
        const { history: swapHistory, promptId: swapPromptId } = await waitPrompt(job, fg, {
          stage: "s5_face_swap",
          timeoutMs: 30 * 60 * 1000,
        });
        const swapFile = outputFile(swapHistory);
        if (!swapFile) throw new SwapChainError("逐帧换脸没有输出", { status: 502, code: "face_swap_no_output" });
        const swapped = await comfy.view(swapFile);
        video = swapped.buffer;
        await fsp.writeFile(job.paths.video, video);
        await makeContactSheet(video, config, job.paths.contact).catch(() => {});
        update(job, { stage: "s6_video_gate", progress: 80 });
        videoGate = await evaluateVideoGate(job, video, config);
        job.gates.video = { ...videoGate, promptId: swapPromptId, mode: "reactor_frame_swap" };
        // 逐帧换脸的改动幅度天然比重绘小：实测 targetMin 3.81，
        // 而 H3 重绘式换人在 7~50 区间。所以只校验「画面没坏」+「确实动过」。
        // 用局部峰值判定「脸是否真的换了」：逐帧换脸只动五官，
        // 整图平均（targetMin）必然被稀释。实测 face 区域峰值可达 20+，
        // 而整图平均只有 1.96。
        const facePeakMin = Math.min(...(videoGate.samples || []).map((item) => item.peakDiff ?? 0));
        const faceMaxMin = Math.min(...(videoGate.samples || []).map((item) => item.maxDiff ?? 0));
        const faceSwapApplied = facePeakMin >= 6 || faceMaxMin >= 15;
        job.gates.faceSwap = {
          applied: faceSwapApplied,
          targetMin: videoGate.targetMin,
          facePeakMin,
          faceMaxMin,
          backgroundOk: videoGate.backgroundOk,
          blackOk: videoGate.blackOk,
          skippedVideoRedraw: true,
        };
        update(job, {});
        if (videoGate.backgroundOk === false || videoGate.blackOk === false) {
          throw new SwapChainError("逐帧换脸后画面异常：背景或亮度不合格", { status: 422, code: "video_gate_failed", details: videoGate });
        }
        if (!faceSwapApplied) {
          throw new SwapChainError(
            `逐帧换脸未生效：人脸区域变化过小（峰值 ${facePeakMin} / 单格最大 ${faceMaxMin}），可能画面里没有人脸`,
            { status: 422, code: "face_swap_not_applied", details: videoGate },
          );
        }
        logger?.info?.(`swap-chain ${job.id} keep_clothes：跳过 H3 重绘，直接逐帧换脸完成`);
      } else {
        for (let attempt = 0; attempt <= MAX_VIDEO_RETRIES; attempt += 1) {
          const graph = job.mode.startsWith("edit_")
            ? editVideoGraph(job, { source: sourceVideo.name, painted: paintedImage.name })
            : swapVideoGraph(job, { source: sourceVideo.name, painted: paintedImage.name });
          if (attempt > 0) {
            const noiseId = Object.keys(graph).find((id) => graph[id].class_type === "RemakeNoise");
            if (noiseId) graph[noiseId].inputs.seed = job.seed + attempt;
          }
          // 视频阶段超时要给足：H3 换人实测一次约 17 分钟（175 帧 736x1280），
          // 而 ComfyUI 刚重启时还要重新加载权重，首次更慢。原来设 20 分钟只有
          // 3 分钟余量，正常生成会被误杀成「执行超时」，白烧一次 17 分钟。
          const { history, promptId } = await waitPrompt(job, graph, { stage: `s5_video_${attempt}`, timeoutMs: 45 * 60 * 1000 });
          const file = outputFile(history);
          if (!file) throw new SwapChainError("视频生成没有输出", { status: 502, code: "video_no_output" });
          const view = await comfy.view(file);
          video = view.buffer;
          await fsp.writeFile(job.paths.video, video);
          await makeContactSheet(video, config, job.paths.contact).catch(() => {});
          update(job, { stage: "s6_video_gate", progress: 80 });
          videoGate = await evaluateVideoGate(job, video, config);
          job.gates.video = { ...videoGate, attempt, promptId };
          update(job, {});
          if (videoGate.pass) break;
        }
        if (!videoGate?.pass) {
          throw new SwapChainError("视频门未通过：身份未持续/背景或亮度异常", { status: 422, code: "video_gate_failed", details: videoGate });
        }
      }
      if (job.sourceFrameCount > 0 && job.frames > job.sourceFrameCount) {
        const trimmedPath = `${job.paths.video}.trim.mp4`;
        await trimToSourceDuration(job.paths.video, trimmedPath, job.sourceFrameCount / 24, config);
        await fsp.copyFile(trimmedPath, job.paths.video);
        job.trimmedToSourceFrames = job.sourceFrameCount;
        update(job, {});
        logger?.info?.(`swap-chain ${job.id} 已裁回源时长 ${(job.sourceFrameCount / 24).toFixed(3)}s（模型 ${job.frames} 帧）`);
      }
      update(job, { status: "completed", stage: "s7_delivery", progress: 100 });
      logger?.info?.(`swap-chain ${job.id} completed (${job.mode})`);
    } catch (error) {
      if (job.cancelRequested || error?.code === "cancelled") {
        job.status = "cancelled";
        job.error = "任务已取消";
        job.updatedAt = new Date().toISOString();
        save();
        return;
      }
      fail(job, error);
    }
  }

  async function cancel(id) {
    load();
    const job = jobs.get(id);
    if (!job) throw new SwapChainError("任务不存在", { status: 404, code: "job_not_found" });
    job.cancelRequested = true;
    job.status = "cancelled";
    job.error = "任务已取消";
    job.updatedAt = new Date().toISOString();
    save();
    const last = job.promptIds[job.promptIds.length - 1]?.promptId;
    if (last) await comfy.interrupt(last).catch(() => {});
    return publicJob(job);
  }

  async function resume(id) {
    load();
    const job = jobs.get(id);
    if (!job) throw new SwapChainError("任务不存在", { status: 404, code: "job_not_found" });
    if (job.status === "running") return publicJob(job);
    job.status = "queued";
    job.stage = "s3_image";
    job.error = null;
    job.progress = 15;
    update(job, {});
    queue.push(id);
    pump();
    return publicJob(job);
  }

  function get(id) {
    load();
    return publicJob(jobs.get(id));
  }

  function list() {
    load();
    return [...jobs.values()].map(publicJob).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function artifactPath(id, name) {
    load();
    const job = jobs.get(id);
    if (!job) return null;
    const map = { video: job.paths.video, painted: job.paths.painted, target: job.paths.target, contact: job.paths.contact };
    return map[name] || null;
  }

  return { load, create, get, list, cancel, resume, artifactPath };
}

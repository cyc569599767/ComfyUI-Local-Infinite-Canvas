import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { probeVideoInfo } from "./video-probe.js";
import { ensureSourceAudio, extractVideoFrames, fitViggleSourceCanvas, flattenViggleReferences, padSourceForSegment, planViggleSegments, runViggleLongVideo, scoreVideoFrames } from "./viggle-long.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

import express from "express";
import multer from "multer";

import { buildContext } from "./bindings.js";
import { h3EasyBinding, h3EasyReferences, h3EasyUploadFiles } from "./h3-easy-media.js";
import { shouldLogRequest } from "./access-log.js";
import { imageInputCapacity } from "./base-models.js";
import { createAssistantManager } from "./assistant.js";
import { registerAgentCloudRoutes } from "./agent-cloud.js";
import { createComfyBridge } from "./comfy-bridge.js";
import { createComfyClient } from "./comfy-client.js";
import { createLogger, loadConfig } from "./config.js";
import { describeAutoDirectories, detectComfyLayout, directoryLoadReport, manualCustomNodeRoots, normalizeDirectorySettings, saveDirectorySettings, scanDirectories, validateDirectorySettings, writeManagedExtraPaths } from "./directories.js";
import { pickFolder } from "./folder-picker.js";
import { createMainModelStore } from "./main-models.js";
import { createModelEventBus } from "./model-events.js";
import { createRegistry } from "./registry.js";
import { createSessionTracker } from "./sessions.js";
import { createSetupManager } from "./setup.js";
import { pickWorkflowDir, workflowDirCandidates } from "./workflow-dir.js";
import { createResourceManager, inferComfyRootFromFolderPaths } from "./resources.js";
import { createPromptOptimizer } from "./prompt-optimizer.js";
import { resolveVariantFallback } from "./variant-fallback.js";
import { createLyricsOptimizer } from "./lyrics-optimizer.js";
import { resolveYue2Precision, runYue2ComfySong, synthesizeSpeech, synthesizeSpeechH3 } from "./audio-local.js";
import { autoSongDuration, buildSongStyle, lyricsDurationIssue } from "./audio-song.js";
import { reorderQwenEditFiles, reorderQwenEditPrompt, stripImageLabelPreamble } from "./qwen-edit.js";
import { createVideoInterpolator } from "./video-interpolation.js";
import { MAX_MERGE_CLIPS, createVideoMerger, parseMergeTimeline } from "./video-merge.js";
import { createPreviewHub } from "./preview-hub.js";
import { createLocalOutputReader } from "./local-output.js";
import { absoluteTaskUrl } from "./public-url.js";
import { createFreeWorkflowStore, applyFreeInputs, publicBinding } from "./free-workflows.js";
import { createWorkflowAppStore } from "./workflow-apps.js";
import { createStoryboardStore } from "./storyboard-projects.js";
import { createStoryboardAi } from "./storyboard-ai.js";
import { createNovelStore } from "./novel-projects.js";
import { createNovelAi } from "./novel-ai.js";
import { createBundleManager } from "./workflow-bundle-manager.js";
import { buildWorkflowGraph, describeWorkflowGraph, detectWorkflowProblems } from "./ui-workflow.js";
import { applyMossLayoutPrompt } from "./layout-prompt.js";
import { collectOutputFiles, runAudio, runImage, runVideo, runWorkflow } from "./runner.js";
import { createSkinUnlockStore } from "./skin-unlocks.js";
import { readSystemStats } from "./system-stats.js";
import { createTaskStore } from "./tasks.js";
import { applyUpdate, checkForUpdate, detectInterruptedUpdate, getUpdateProgress, recoverWorkflowBackups, restoreInterruptedUpdate } from "./update.js";
import { uploadImages } from "./uploads.js";
import { buildScene3dPrompt, evaluateScene3dMetrics, placeSource, prepareSeamAssets, resolveScene3dPython, scene3dScriptPath, SCENE3D_PANO_ID, SCENE3D_SEAM_ID, stitchPanorama } from "./scene3d.js";
import { createSwapChain } from "./swap-chain.js";
import { createWorkflowVisibilityStore } from "./workflow-visibility.js";
import { createWorkflowLabelStore } from "./workflow-labels.js";
import { assertModelConfigurable, createWorkflowModelOverrideStore, validateWorkflowModelPatch, workflowModelFields } from "./workflow-model-overrides.js";
import { missingNodeClasses, workflowAvailabilityProblem } from "./workflow-availability.js";
import { alignH3Frames, alignViggleFramesUp, capH3ReferenceFrames, framesFromSeconds, extFromMime, jsonError, nowIso, parseSize, randomId, safeFileName, sleep, VIGGLE_MAX_FRAMES, VIGGLE_MIN_FRAMES } from "./util.js";
import { exceedsH3PixelLimit, h3PixelLimitMessage, snap32 } from "./h3-canvas-limit.js";
import { findMissingSwapChainModels, isModelCatalogReady, missingSwapChainMessage } from "./swap-chain-models.js";

class HttpError extends Error {
  constructor(message, { status = 400, code = "bad_request", details } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// SageAttention 探测：复用资源中心的 pip 检测，5 分钟内只算一次，避免每个视频任务全量扫资源。
const SAGE_PROBE_TTL_MS = 5 * 60 * 1000;
let sageProbeCache = { at: 0, available: null, pending: null };
function probeSageAvailability(resources) {
  const now = Date.now();
  if (now - sageProbeCache.at < SAGE_PROBE_TTL_MS && sageProbeCache.available !== null) {
    return Promise.resolve(sageProbeCache.available);
  }
  if (!sageProbeCache.pending) {
    sageProbeCache.pending = Promise.resolve()
      .then(() => resources.status())
      .then((result) => {
        const item = (result.resources || []).find((entry) => entry.id === "sage_h3");
        const available = item ? item.present !== false : null;
        sageProbeCache = { at: Date.now(), available, pending: null };
        return available;
      })
      .catch(() => {
        sageProbeCache = { at: 0, available: null, pending: null };
        return null;
      });
  }
  return sageProbeCache.pending;
}

const uploadBudgetSymbol = Symbol("uploadBudget");

function createBoundedMemoryStorage(maxTotalBytes) {
  const limit = maxTotalBytes >= 1024 * 1024
    ? `${Math.round(maxTotalBytes / (1024 * 1024))} MB`
    : `${Math.ceil(maxTotalBytes / 1024)} KB`;
  const exceeded = () => new HttpError(`上传文件总大小超过 ${limit} 请求预算，请减少素材或分批重试。`, {
    status: 413,
    code: "upload_total_too_large",
  });
  return {
    _handleFile(req, file, cb) {
      const budget = req[uploadBudgetSymbol] || { bytes: 0, failed: false };
      req[uploadBudgetSymbol] = budget;
      const chunks = [];
      let done = false;
      const finish = (...args) => {
        if (done) return;
        done = true;
        cb(...args);
      };
      if (budget.failed) {
        file.stream.resume();
        finish(exceeded());
        return;
      }
      file.stream.on("data", (chunk) => {
        if (budget.failed) return;
        budget.bytes += chunk.length;
        if (budget.bytes > maxTotalBytes) {
          budget.failed = true;
          chunks.length = 0;
          finish(exceeded());
          return;
        }
        chunks.push(chunk);
      });
      file.stream.on("end", () => {
        if (budget.failed) return finish();
        const buffer = Buffer.concat(chunks);
        finish(null, { buffer, size: buffer.length });
      });
      file.stream.on("error", finish);
    },
    _removeFile(_req, file, cb) {
      delete file.buffer;
      cb(null);
    },
  };
}

function requestGatewayToken(req) {
  const header = req.headers["x-gateway-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function gatewayTokenMatches(candidate, expected) {
  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function gpuVramTotalGb(stats) {
  const totals = (stats?.gpu || [])
    .map((gpu) => Number(gpu.memoryTotalMb))
    .filter((value) => Number.isFinite(value) && value > 0);
  return totals.length ? Math.max(...totals) / 1024 : 0;
}

function corsMiddleware(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    let localOrigin = false;
    try {
      localOrigin = Boolean(origin) && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(origin).hostname);
    } catch {
      localOrigin = false;
    }
    const allowed = config.corsOrigins.includes("*") || localOrigin || (origin && config.corsOrigins.includes(origin));
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.includes("*") ? "*" : origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-Request-Id, X-Gateway-Token");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

function abortOnDisconnect(req, res, register) {
  const controller = new AbortController();
  const unregister = register?.(req.id, controller);
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", abort);
  res.on("close", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", abort);
      res.off("close", abort);
      unregister?.();
    },
  };
}

function parseFreeTexts(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 自定义绑定项的值。格式与 texts 相同（{node, input, value}），但来源不同：
 * 这些是用户主动固定到卡片上的配置项，值可能是数字/布尔，不做字符串化，
 * 交给 applyFreeInputs 按工作流原值类型转换。
 */
function parseFreeValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function freeEffectivePrompt(entry, texts, prompt) {
  const binding = entry?.bindings?.prompt;
  if (!binding) return String(prompt || "");
  const match = (Array.isArray(texts) ? texts : []).find(
    (item) => String(item?.node ?? "") === String(binding.node) && String(item?.input ?? "") === String(binding.input),
  );
  return String(match?.value ?? prompt ?? "");
}

const AUDIO_MODES = ["voice-design", "voice-clone", "music"];
// voice_description 缺失时的兜底：明确中性嗓音，避免 Qwen3-TTS 自由发挥导致性别/年龄错乱。
const AUDIO_NEUTRAL_VOICE = "自然清晰的中性嗓音，无明显性别与年龄特征，语速平稳。";
// MiniMax Music3 的 max_duration 是 0.04 步进的秒数；非有限数会写进工作流变成 null，先挡掉。
function normalizeMaxDuration(value) {
  if (value === undefined || value === null || value === "") return 60;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new HttpError("max_duration 必须是大于 0 的秒数", { status: 400, code: "invalid_max_duration" });
  }
  return Math.max(1, Math.min(360, seconds));
}

function parseParams(value) {  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 落到下面的统一错误。
    }
  }
  throw new HttpError("params 必须是 JSON 对象", { status: 400, code: "invalid_params" });
}

function imageFilesFrom(files = []) {
  return files.filter((file) => /image|frame/i.test(file.fieldname || ""));
}

function orderedVideoFiles(files = []) {
  const groups = ["first_frame", "last_frame", "image", "image[]", "images"];
  const ordered = [];
  const seen = new Set();
  const push = (file) => {
    if (!file?.buffer) return;
    const hash = crypto.createHash("sha1").update(file.buffer).digest("hex");
    if (seen.has(hash)) return;
    seen.add(hash);
    ordered.push(file);
  };
  for (const group of groups) files.filter((file) => file.fieldname === group).forEach(push);
  for (const file of files) if (/image|frame/i.test(file.fieldname || "")) push(file);
  return ordered.slice(0, 8);
}

function orderedPromptImages(files = []) {
  const byName = new Map(files.filter((file) => file?.buffer).map((file) => [file.fieldname, file]));
  const ordered = [];
  const take = (name) => {
    const file = byName.get(name);
    if (!file) return;
    byName.delete(name);
    ordered.push(file);
  };
  take("image");
  take("image1");
  take("images");
  for (let index = 2; index <= 15; index += 1) take(`image${index}`);
  for (const file of files) {
    if (ordered.length >= 15) break;
    if (file?.buffer && /image|frame/i.test(file.fieldname || "") && !ordered.includes(file)) ordered.push(file);
  }
  return ordered.slice(0, 15);
}

function orderedVideoRefFiles(files = []) {
  return files.filter((file) => file?.buffer && /^videos?(\[\])?$/i.test(file.fieldname || "")).slice(0, 1);
}

function orderedAudioRefFiles(files = []) {
  return files.filter((file) => file?.buffer && /^audios?(\[\])?$/i.test(file.fieldname || "")).slice(0, 2);
}

const RGBA_PROMPT_PREFIX = "This is an RGBA format image with transparency.";
const RGBA_PROMPT_SUFFIX = "The image has an alpha channel and a transparent background.";

function applyBackgroundPrompt(prompt, background, entry) {
  if (background !== "transparent" || !entry?.backgroundPrompt) return prompt;
  const text = String(prompt || "").trim();
  if (/alpha channel|RGBA/i.test(text)) return text;
  return `${RGBA_PROMPT_PREFIX} ${text} ${RGBA_PROMPT_SUFFIX}`.trim();
}

function requireModel(registry, setup, model, expectedType, { mode = "", allowUnavailable = false } = {}) {
  const name = String(model || "").trim();
  if (!name) throw new HttpError("缺少 model 参数", { status: 400, code: "missing_model" });
  const found = registry.resolveModel(name, (setup.loaderOptions?.() || {}));
  if (!found) throw new HttpError(`未找到模型：${name}。请先在网关注册工作流，或在画布渠道里拉取模型列表。`, { status: 404, code: "model_not_found" });
  if (expectedType && found.entry.type !== expectedType) throw new HttpError(`模型 ${name} 的类型是 ${found.entry.type}，不是 ${expectedType}`, { status: 400, code: "model_type_mismatch" });
  const unavailable = workflowAvailabilityProblem(setup, found.entry, { mode, allowUnavailable });
  if (unavailable) throw new HttpError(unavailable.message, { status: 409, code: unavailable.code, details: unavailable.details });
  return found.entry;
}

function requireWorkflowMode(setup, entry, mode) {
  const unavailable = workflowAvailabilityProblem(setup, entry, { mode });
  if (unavailable) throw new HttpError(unavailable.message, { status: 409, code: unavailable.code, details: unavailable.details });
}

// 字段名会重复出现在普通节点里，必须同时匹配已发现的 loader classType 和 input。
function diagnosticLoaderPairs(setup) {
  const pairs = new Set();
  for (const spec of setup?.modelLoaderSpecs?.() || []) {
    if (!spec?.classType || !spec?.input) continue;
    pairs.add(`${spec.classType}\u0000${spec.input}`);
  }
  return pairs;
}

// loader 值允许保留 ComfyUI 内的相对子目录，但不能把本机绝对路径带进诊断。
function sanitizeModelValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  const normalized = text.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") || normalized.startsWith("/")) {
    return normalized.split("/").filter(Boolean).pop() || "";
  }
  return text;
}

function sanitizeDiagnosticText(value) {
  return String(value ?? "")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|，。；）)]+/g, "<path>")
    .replace(/\/(?:Users|home|root|tmp|var|opt|mnt)\/[^\s"'<>|，。；）)]+/g, "<path>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(authorization|token|api[_-]?key|secret|password|cookie)\b\s*[:=]\s*[^\s,;"']+/gi, "$1=<redacted>");
}

function sanitizeComfyUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function setupSyncSummary(status, instanceId) {
  return {
    instanceId: instanceId || status?.instanceId || "",
    scanId: status?.scanId ?? 0,
    revision: status?.revision ?? 0,
    phase: status?.phase || "idle",
    scanning: status?.scanning === true,
    stale: status?.stale === true,
    comfyReachable: status?.comfyReachable === true,
    scannedAt: status?.scannedAt || null,
    counts: status?.counts || { available: 0, unavailable: 0, total: 0 },
  };
}

function diagnosticProblems(problems = [], limit = 20) {
  return (Array.isArray(problems) ? problems : [])
    .slice(0, limit)
    .map((problem) => ({
      type: String(problem?.type || "problem"),
      message: sanitizeDiagnosticText(problem?.message || ""),
      classType: problem?.classType ? String(problem.classType) : undefined,
      input: problem?.input ? String(problem.input) : undefined,
      value: problem?.value ? sanitizeModelValue(problem.value) : undefined,
      candidates: Array.isArray(problem?.candidates)
        ? problem.candidates.slice(0, 10).map(sanitizeModelValue)
        : undefined,
    }));
}

function setupProblemSummary(status) {
  const missing = status?.missing || {};
  const list = (items) => (Array.isArray(items) ? items : []);
  return {
    models: list(missing.models).slice(0, 10).map(sanitizeDiagnosticText),
    modelCount: list(missing.models).length,
    nodes: list(missing.nodes).slice(0, 10).map(sanitizeDiagnosticText),
    nodeCount: list(missing.nodes).length,
    runtime: list(missing.runtime).slice(0, 10).map(sanitizeDiagnosticText),
    restart: list(missing.restart).slice(0, 10).map(sanitizeDiagnosticText),
    uiWorkflows: Number(missing.uiWorkflows || 0),
    uiSamples: list(missing.uiSamples).slice(0, 5).map(sanitizeDiagnosticText),
  };
}

function workflowLoaderEvidence(entry, setup, status) {
  const specs = setup.modelLoaderSpecs?.() || [];
  const catalog = setup.loaderOptions?.() || {};
  const rows = [];
  for (const [nodeId, node] of Object.entries(entry?.workflow || {})) {
    const classType = node?.class_type;
    if (!classType) continue;
    for (const spec of specs) {
      if (spec.classType !== classType) continue;
      const expected = node.inputs?.[spec.input];
      if (typeof expected !== "string" || !expected.trim()) continue;
      const options = Array.isArray(catalog[`${classType}\u0000${spec.input}`])
        ? catalog[`${classType}\u0000${spec.input}`]
        : entry.strictModelNames ? [] : Array.isArray(catalog[classType]) ? catalog[classType] : [];
      const wanted = expected.replace(/\\/g, "/");
      const installed = options.some((item) => entry.strictModelNames
        ? String(item).replace(/\\/g, "/") === wanted
        : String(item).replace(/\\/g, "/").toLowerCase() === wanted.toLowerCase());
      const alias = setup.modelAliasFor?.(classType, spec.input, expected, null, entry) || "";
      const problem = (status?.problems || []).find((item) => item.classType === classType && item.input === spec.input && (!item.value || item.value === expected));
      const candidates = (setup.modelCandidates?.(classType, expected, spec.input) || []).slice(0, 10);
      rows.push({
        nodeId,
        classType,
        input: spec.input,
        expected: sanitizeModelValue(expected),
        installed,
        alias: alias ? sanitizeModelValue(alias) : null,
        effective: sanitizeModelValue(alias || expected),
        candidates: candidates.map(sanitizeModelValue),
        availability: {
          available: !problem,
          problemType: problem?.type || null,
          message: problem ? sanitizeDiagnosticText(problem.message) : null,
        },
      });
    }
  }
  return rows;
}

function diagnosticWorkflow(entry, setup, status, { workflowVisibility } = {}) {
  const variants = {};
  for (const [mode, variant] of Object.entries(status?.variants || {})) {
    variants[mode] = {
      available: variant?.available === true,
      problems: diagnosticProblems(variant?.problems),
    };
  }
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    enabled: entry.hidden !== true && !workflowVisibility?.isHidden?.(entry.id),
    available: status?.available === true,
    stale: status?.stale === true,
    problems: diagnosticProblems(status?.problems),
    variants,
    loaders: workflowLoaderEvidence(entry, setup, status),
  };
}

function isLoopbackPeer(address) {
  const raw = String(address || "").replace(/^::ffff:/i, "");
  return raw === "::1" || raw === "localhost" || raw.startsWith("127.");
}

export async function stopGateway({ tasks, comfy, setup, server, abortActiveRequests, assistant, logger } = {}) {
  try {
    setup?.stop?.();
  } catch {
    /* 关停清理失败不应阻塞退出 */
  }
  try {
    abortActiveRequests?.();
  } catch {
    /* 同上 */
  }
  try {
    await assistant?.stop?.("gateway-shutdown");
  } catch {
    /* Agent 停机失败不应阻塞网关退出 */
  }
  try {
    server?.close?.();
  } catch {
    /* 同上 */
  }
  const result = await tasks.cancelInFlight(comfy, { timeoutMs: 2500 });
  if (result.total) logger?.info?.(`关停取消 ${result.total} 个在途任务${result.timedOut ? "（等待超时）" : ""}`);
  await tasks.persistNow();
  return result;
}

export async function createGatewayApp(overrides = {}) {
  const config = loadConfig(overrides);
  const logger = createLogger(overrides.logPrefix || "gateway");
  const assistant = createAssistantManager({ config, logger, idleMs: config.assistantIdleMs });
  try {
    const recovery = config.desktopDistribution ? { restored: [] } : await recoverWorkflowBackups(config);
    const interruptedUpdate = config.desktopDistribution ? { pending: false } : await detectInterruptedUpdate(config).catch(() => ({ pending: false }));
    if (interruptedUpdate.pending) {
      logger.warn(`检测到未完成的更新 v${interruptedUpdate.version}（当前 v${interruptedUpdate.currentVersion}）；可调用 POST /api/update/recovery/restore 回滚，或重新应用完整包。`);
    }
    if (recovery.restored.length) {
      logger.warn(`升级后恢复 ${recovery.restored.length} 个本地修改的工作流；新版官方文件保存在 .update-backup/${config.version}/official-new`);
    }
  } catch (error) {
    logger.warn(`恢复升级前工作流失败：${error.message}`);
  }
  const previewHub = createPreviewHub({ comfyUrl: () => comfy.baseUrl(), logger });
  const comfy = createComfyClient({
    baseUrl: config.comfyUrl,
    autoDiscover: !config.desktopDistribution,
    timeoutMs: config.requestTimeoutMs,
    downloadTimeoutMs: config.comfyDownloadTimeoutMs,
    retryAttempts: config.comfyRetryAttempts,
    retryDelayMs: config.comfyRetryDelayMs,
    logger,
    previewHub,
    // 把网关自身端口交给客户端，避免自动嗅探把自己当成 ComfyUI。
    selfPorts: [config.port],
    // ComfyUI 输出的本地目录：/view 端点坏掉时直接读磁盘兜底
    // （现场：/view 回 200 但响应体 0 字节，重试到超时也拿不到文件）。
    // 惰性求值 —— setup 在本 client 之后才创建，构造时还拿不到 ComfyUI 根目录。
    localOutputDirs: () => {
      // setup 在本 client 之后才用 const 声明；调用发生在运行期，此时已可用，
      // 但仍用 typeof 兜一下，避免初始化早期被调用时踩 TDZ。
      const root =
        (typeof setup !== "undefined" ? setup?.comfyRootForScan?.() : "") || config.comfyDir || "";
      return root ? [path.join(root, "output"), path.join(root, "temp"), path.join(root, "input")] : [];
    },
  });
  const mainModels = createMainModelStore({ dataDir: config.dataDir, logger });
  await mainModels.load();
  // ComfyUI 的 /view 偶发返回 200 却不发 body（HEAD 正常、文件已完整落盘）。
  // 本机部署知道 comfyDir，就直接从 output 目录兜底，避免「已生成但画布收不到」。
  const readLocalOutput = createLocalOutputReader({ comfyDir: config.comfyDir });
  // label 覆盖必须早于 registry 加载，registry 构建 entry 时会同步读取。
  const workflowLabels = createWorkflowLabelStore({ dataDir: config.dataDir, logger });
  await workflowLabels.load();
  const workflowModels = createWorkflowModelOverrideStore({ dataDir: config.dataDir, logger });
  await workflowModels.load();
  const registry = createRegistry({
    dir: config.workflowDir,
    maxWorkflowBytes: config.maxWorkflowBytes,
    logger,
    mainModelFile: (id) => mainModels.fileForWorkflow(id),
    labelOverride: (id) => workflowLabels.get(id),
    workflowOverride: workflowModels.apply,
  });
  await registry.load();
  const tasks = createTaskStore({
    dataDir: config.dataDir,
    logger,
    retentionDays: config.taskRetentionDays,
    maxTasks: config.maxStoredTasks,
  });
  await tasks.load();
  const taskResponse = (req, task) => {
    const data = tasks.publicTask(task);
    return { ...data, url: data.url ? absoluteTaskUrl(config, req, data.url) : null };
  };
  const freeWorkflows = createFreeWorkflowStore({
    dataDir: config.dataDir,
    comfyWorkflowsDir: config.comfyWorkflowsDir,
    getComfyWorkflowsDir: () => config.comfyWorkflowsDir,
    comfy,
    logger,
    maxWorkflowBytes: config.maxWorkflowBytes,
  });
  await freeWorkflows.load();
  // 角色替换长链（上游 swap-chain）：按段生成并逐段接力，产物落 dataDir。
  const swapChain = createSwapChain({
    comfy,
    config,
    logger,
    dataDir: config.dataDir,
    // 逐帧换脸要用 VHS_LoadVideoPath，它只认磁盘绝对路径，需要 ComfyUI 根目录。
    comfyRoot: () => (typeof setup !== "undefined" ? setup?.comfyRootForScan?.() : "") || config.comfyDir || "",
  });
  swapChain.load();
  // G1：后台轮询 ComfyUI 工作流目录，源文件改了就防抖同步（不阻塞启动）。
  // 定时器 unref，退出时不需要额外清理；sync 失败只记 warn。
  freeWorkflows.startWatching({
    intervalMs: config.freeWorkflowWatchMs ?? 3000,
    debounceMs: config.freeWorkflowSyncDebounceMs ?? 1200,
    onSynced: (entry) => logger.info(`free workflow auto-synced ${entry?.name || entry?.id || ""}`),
  });
  const workflowApps = createWorkflowAppStore({ dataDir: config.dataDir, logger });
  await workflowApps.load();
  const storyboards = createStoryboardStore({ dataDir: config.dataDir, logger });
  await storyboards.load();
  const storyboardAi = createStoryboardAi({ logger, comfy });
  const novels = createNovelStore({ dataDir: config.dataDir, logger });
  await novels.load();
  const novelAi = createNovelAi({ logger, comfy });
  const skinUnlocks = createSkinUnlockStore({ dataDir: config.dataDir, logger });
  await skinUnlocks.load();
  const workflowVisibility = createWorkflowVisibilityStore({ dataDir: config.dataDir, logger });
  await workflowVisibility.load();
  const modelEvents = createModelEventBus({ logger });
  const comfyBridge = createComfyBridge({ config, logger });
  const bridgeStatus = await comfyBridge.ensure();
  if (!bridgeStatus.installed) logger.warn(`ComfyUI 工作流桥接未安装：${bridgeStatus.reason || "未知原因"}`);
  const sessions = createSessionTracker({ staleMs: config.sessionStaleSec * 1000 });
  const setup = createSetupManager({
    config,
    registry,
    comfy,
    logger,
    mainModelFile: (id) => mainModels.fileForWorkflow(id),
    // 扫描成功/失败、断线、重连、目录/别名等变化都复用这一条广播路径；
    // 只带 revision 信号与快照代际，不推送模型列表正文。
    onScanComplete: (status, meta = {}) => {
      const reason = meta.ok === false ? (meta.reason === "offline" ? "offline" : "scan-failed") : meta.reason || "scan";
      modelEvents.broadcast(reason, {
        scanId: status?.scanId,
        setupRevision: status?.revision,
        stale: status?.stale,
        instanceId: status?.instanceId,
      });
    },
  });
  const emitModelChange = (reason) => {
    const status = setup.status();
    return modelEvents.broadcast(reason, {
      scanId: status.scanId,
      setupRevision: status.revision,
      stale: status.stale,
      instanceId: status.instanceId,
    });
  };
  // 注册表内容变化后必须重建 setup 快照，禁止同一 ID 的新工作流沿用旧可用性。
  const reloadRegistryAndSnapshot = async (reason = "registry-reload") => {
    const changed = await registry.reloadIfChanged();
    if (!changed && setup.registrySnapshotCurrent()) return;
    const pending = setup.scan(reason);
    // 首扫尚未完成时不阻塞模型列表；已有成功快照时等新代际提交，避免返回跨代数据。
    if (setup.status().scanId > 0) await pending;
  };
  if (config.allowRemote && !config.gatewayToken) {
    logger.warn("ALLOW_REMOTE=1 但未设置 GATEWAY_TOKEN：接口无令牌保护，仅可在可信内网使用，不要映射到公网。");
  }
  const resources = createResourceManager({ config, setup, registry, logger, workflowVisibility, mainModels });
  await resources.init();
  setup.setRuntimeProblemProvider?.((workflowId) => resources.runtimeProblemsFor(workflowId));
  const bundles = createBundleManager({
    freeWorkflows,
    workflowApps,
    setup,
    resources,
    comfy,
    resolveWorkflowsDir: async () => (await resolveFreeWorkflowsDir()).dir,
    logger,
  });
  // 启动器只靠端口接管 ComfyUI 时可能拿不到安装目录；自由卡片仍应能工作。
  async function resolveFreeWorkflowsDir() {
    const collect = (folderPaths) =>
      workflowDirCandidates({
        configured: config.comfyWorkflowsDir,
        comfyDir: config.comfyDir,
        comfyRoot: resources.comfyRoot?.() || "",
        folderPaths,
      });
    let tried = collect(setup.folderPaths?.() || {});
    let dir = pickWorkflowDir(tried);
    if (!dir) {
      const liveFolderPaths = await comfy.folderPaths().catch(() => ({}));
      tried = [...new Set([...tried, ...collect(liveFolderPaths)])];
      dir = pickWorkflowDir(tried);
    }
    if (dir && path.resolve(dir) !== path.resolve(config.comfyWorkflowsDir || "")) {
      config.comfyWorkflowsDir = dir;
      logger.info(`已自动识别 ComfyUI 工作流目录：${dir}`);
    }
    return { dir, tried };
  }
  // 随包节点由启动器首次启动复制；直接用 start-all/start-gateway 启动时这里补一次（幂等）
  void ensureBundledNodes();
  async function ensureBundledNodes() {
    if (process.env.DISABLE_NODE_BOOTSTRAP === "1") return;
    try {
      const packageRoot = path.join(config.rootDir, "..");
      const modulePath = path.join(packageRoot, "launcher", "bootstrap-nodes.mjs");
      if (!fs.existsSync(modulePath)) return;
      const comfyDir = resources.comfyRoot();
      if (!comfyDir) return;
      const { installBundledNodes } = await import(pathToFileURL(modulePath).href);
      const installed = await installBundledNodes({
        root: packageRoot,
        comfyRoot: comfyDir,
        comfyUrl: config.comfyUrl,
        customNodesDirs: manualCustomNodeRoots(setup?.getDirectorySettings?.() || null),
        log: (message, level) => (level === "WARN" ? logger.warn(message) : logger.info(message)),
      });
      if (installed.length) logger.info(`已放置 ${installed.length} 个随包节点，重启 ComfyUI 后生效`);
    } catch (error) {
      logger.warn(`随包节点检查失败：${error.message}`);
    }
  }
  let lastOOM = null;
  const activeRequests = new Map();
  const registerActiveRequest = (id, controller) => {
    const key = String(id || "");
    if (!key) return () => {};
    activeRequests.set(key, controller);
    return () => {
      if (activeRequests.get(key) === controller) activeRequests.delete(key);
    };
  };
  const abortActiveRequests = () => {
    for (const controller of activeRequests.values()) {
      try {
        controller.abort();
      } catch {
        /* 单个请求取消失败不影响关停 */
      }
    }
    activeRequests.clear();
  };
  const promptOptimizer = createPromptOptimizer({
    config,
    comfy,
    logger,
    userModelAliasFor: setup.userModelAliasFor,
    modelAliasFor: setup.modelAliasFor,
    loaderSpecs: () => setup.modelLoaderSpecs?.(),
  });
  // 歌词优化复用本机/云端文本 API（assistant/agent-provider.json），与写歌路由分开，互不影响。
  const lyricsOptimizer = createLyricsOptimizer({ appRoot: config.appRoot });
  const videoInterpolator = createVideoInterpolator({ config, logger });
  const videoMerger = createVideoMerger({ config, logger });

  // 把 parameters.optionsFrom（如 "UpscaleModelLoader.model_name"）替换成 ComfyUI 实时选项。
  const isUpscaleModelOption = (name) => {
    const parts = String(name || "").replace(/\\/g, "/").split("/").filter(Boolean);
    // ComfyUI 的 upscale_models 有时会把整个 models 根也列进来；只保留根文件和真正的放大模型目录。
    return parts.length === 1 || /^(?:upscale_models?|esrgan|upscalers?|4x)$/i.test(parts[0]);
  };

  const uniqueByBasename = (options) => {
    const seen = new Set();
    return options.filter((name) => {
      const base = String(name || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
      if (!base || seen.has(base)) return false;
      seen.add(base);
      return true;
    });
  };

  const enrichParameters = (parameters) => {
    const loaders = setup.loaderOptions?.() || {};
    return (Array.isArray(parameters) ? parameters : []).map((parameter) => {
      const source = String(parameter?.optionsFrom || "").trim();
      if (!source) return parameter;
      const [classType] = source.split(".");
      let options = Array.isArray(loaders[classType]) ? loaders[classType] : [];
      if (source === "UpscaleModelLoader.model_name") options = uniqueByBasename(options.filter(isUpscaleModelOption));
      return { ...parameter, options };
    });
  };

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const incomingId = String(req.headers["x-request-id"] || "").replace(/[^\w.:-]/g, "").slice(0, 100);
    req.id = incomingId || randomId("req_");
    res.setHeader("X-Request-Id", req.id);
    const started = Date.now();
    res.on("finish", () => {
      if (shouldLogRequest(req.path, res.statusCode, req.method)) logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms ${req.id}`);
    });
    next();
  });
  app.use(corsMiddleware(config));
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  const localOriginHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    try {
      if (localOriginHosts.has(new URL(origin).hostname)) return true;
    } catch {
      return false;
    }
    return config.corsOrigins.includes(origin) || config.corsOrigins.includes("*") || origin === config.publicBaseUrl;
  };
  app.use((req, res, next) => {
    // 管理接口支持令牌；生成与媒体链的远程鉴权需和前端请求、SSE、Blob 一起迁移。
    if (config.allowRemote && config.gatewayToken && (req.path.startsWith("/api/") || req.path === "/admin")) {
      if (!gatewayTokenMatches(requestGatewayToken(req), config.gatewayToken)) {
        res.status(401).json({ ok: false, error: { message: "缺少有效的网关令牌", code: "unauthorized" } });
        return;
      }
    }
    // 跨站请求防护：浏览器发起的写操作必须来自本地或 CORS 白名单
    if (!SAFE_METHODS.has(req.method)) {
      const origin = String(req.headers.origin || "");
      const site = String(req.headers["sec-fetch-site"] || "");
      // Edge/Chromium 把 localhost:3000 页面访问 127.0.0.1 网关记为 cross-site，但两端都是本机回环；
      // 白名单 Origin 同理放行。缺少 Origin 的跨站写请求和外部来源仍然拒绝。
      const trustedCrossSite = site === "cross-site" && Boolean(origin) && isAllowedOrigin(origin);
      if (!isAllowedOrigin(origin) || (site === "cross-site" && !trustedCrossSite)) {
        if (site === "cross-site") logger.warn(`拒绝跨站写请求 ${req.method} ${req.path} origin=${origin || "-"} sec-fetch-site=${site} ${req.id}`);
        res.status(403).json({ ok: false, error: { message: "跨站请求被拒绝" } });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  registerAgentCloudRoutes(app, { config });
  const upload = multer({
    storage: createBoundedMemoryStorage(config.maxTotalUploadBytes),
    limits: { fileSize: config.maxUploadBytes, files: 12 },
  });
  const creationVideoUpload = multer({
    storage: createBoundedMemoryStorage(config.maxTotalUploadBytes),
    limits: { fileSize: config.maxUploadBytes, files: 15 },
  });
  const videoMergeUpload = multer({
    storage: createBoundedMemoryStorage(config.maxTotalUploadBytes),
    limits: { fileSize: config.maxUploadBytes, files: MAX_MERGE_CLIPS },
  });

  app.get("/health", async (_req, res) => {
    const reachable = await Promise.race([comfy.isReachable(), sleep(1500).then(() => false)]);
    const setupStatus = setup.status();
    const interrupted = config.desktopDistribution ? { pending: false } : await detectInterruptedUpdate(config).catch(() => ({ pending: false }));
    res.json({
      status: "ok",
      desktopDistribution: config.desktopDistribution === true,
      version: config.version,
      updateRecovery: interrupted.pending ? { pending: true, version: interrupted.version, files: interrupted.files?.length || 0 } : null,
      comfy: { url: comfy.baseUrl(), reachable },
      // 与设置页一致：hidden 的辅助工作流不计入可用性统计。
      workflows: { count: setupStatus.counts?.total || registry.list().length },
      setup: {
        phase: setupStatus.phase,
        counts: setupStatus.counts,
        instanceId: setupStatus.instanceId,
        scanId: setupStatus.scanId,
        revision: setupStatus.revision,
        scanning: setupStatus.scanning,
        stale: setupStatus.stale,
      },
      tasks: { count: tasks.list().length, retentionDays: config.taskRetentionDays, maxStoredTasks: config.maxStoredTasks },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/api/setup/status", (_req, res) => {
    // revision 是 SSE 变更序列号，setup.revision 是最近一次成功提交的扫描代际。
    res.json({ ok: true, status: setup.status(), comfyUrl: comfy.baseUrl(), revision: modelEvents.snapshot().revision });
  });

  app.get("/api/setup/diagnostics", async (req, res) => {
    const queryText = (value, field) => {
      if (value === undefined) return "";
      const raw = String(value).trim();
      if (!raw) return "";
      if (raw.length > 200) throw new HttpError(`${field} 过长`, { status: 400, code: "invalid_query" });
      return raw;
    };
    const workflowId = queryText(req.query.workflowId, "workflowId");
    const modelId = queryText(req.query.modelId, "modelId");
    const promptId = queryText(req.query.promptId, "promptId");
    if (promptId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(promptId)) {
      throw new HttpError("promptId 格式不合法", { status: 400, code: "invalid_prompt_id" });
    }

    const setupStatus = setup.status();
    let workflowEntry = null;
    if (workflowId) {
      workflowEntry = registry.resolve(workflowId);
      if (!workflowEntry) throw new HttpError(`工作流不存在：${workflowId}`, { status: 404, code: "workflow_not_found" });
    }
    let modelEntry = null;
    if (modelId) {
      const found = registry.resolveModel(modelId, setup.loaderOptions?.() || {});
      if (!found) throw new HttpError(`未找到模型：${modelId}`, { status: 404, code: "model_not_found" });
      modelEntry = found.entry;
    }

    let execution = null;
    if (promptId) {
      let history = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        history = await comfy.history(promptId, { signal: controller.signal });
      } catch (error) {
        throw new HttpError(`读取 ComfyUI 执行记录失败：${sanitizeDiagnosticText(error?.message || error)}`, { status: 502, code: "comfy_history_failed" });
      } finally {
        clearTimeout(timer);
      }
      if (!history) throw new HttpError(`未找到执行记录：${promptId}`, { status: 404, code: "prompt_not_found" });
      // 真实执行图在 history.prompt[2]；只提取已发现 loader spec 的精确 classType + input。
      const graph = Array.isArray(history.prompt) ? history.prompt[2] : history.prompt;
      const loaderPairs = diagnosticLoaderPairs(setup);
      const nodes = [];
      for (const [nodeId, node] of Object.entries(graph && typeof graph === "object" ? graph : {})) {
        if (!node?.class_type) continue;
        const classType = String(node.class_type);
        const fields = {};
        for (const [key, value] of Object.entries(node.inputs || {})) {
          if (!loaderPairs.has(`${classType}\u0000${key}`)) continue;
          if (typeof value !== "string" || !value) continue;
          fields[key] = sanitizeModelValue(value);
        }
        if (Object.keys(fields).length) nodes.push({ nodeId, classType, fields });
      }
      execution = {
        promptId,
        status: sanitizeDiagnosticText(history.status?.status_str || ""),
        completed: history.status?.completed === true,
        nodes,
      };
    }

    const evidenceEntry = modelEntry || workflowEntry;
    const evidenceStatus = evidenceEntry ? setup.workflowStatus(evidenceEntry.id) : null;
    res.json({
      ok: true,
      version: config.version,
      generatedAt: nowIso(),
      comfy: {
        url: sanitizeComfyUrl(comfy.baseUrl()),
        reachable: setupStatus.comfyReachable === true,
      },
      setup: {
        instanceId: setupStatus.instanceId || "",
        scanId: setupStatus.scanId ?? 0,
        revision: setupStatus.revision ?? 0,
        phase: setupStatus.phase,
        scanning: setupStatus.scanning === true,
        stale: setupStatus.stale === true,
        comfyReachable: setupStatus.comfyReachable === true,
        scannedAt: setupStatus.scannedAt || null,
        counts: setupStatus.counts || { available: 0, unavailable: 0, total: 0 },
        lastError: setupStatus.lastError ? sanitizeDiagnosticText(setupStatus.lastError) : null,
        problems: setupProblemSummary(setupStatus),
      },
      workflow: workflowEntry ? diagnosticWorkflow(workflowEntry, setup, setup.workflowStatus(workflowEntry.id), { workflowVisibility }) : null,
      model: modelEntry
        ? {
            id: modelId,
            workflowId: evidenceEntry.id,
            ...diagnosticWorkflow(evidenceEntry, setup, evidenceStatus, { workflowVisibility }),
          }
        : null,
      execution,
      links: { models: "/v1/models", status: "/api/setup/status", events: "/api/models/events" },
    });
  });

  app.post("/api/setup/model-alias", async (req, res) => {
    try {
      const status = await setup.setModelAlias(req.body || {});
      res.json({ ok: true, status });
    } catch (error) {
      res.status(error?.status || 400).json({ ok: false, error: { message: error?.message || String(error) } });
    }
  });

  app.get("/api/resources/status", (_req, res) => {
    res.json(resources.status());
  });

  app.post("/api/resources/pick-replacement", async (req, res) => {
    try {
      const file = await resources.pickResourceReplacement(String(req.body?.resourceId || ""));
      res.json({ ok: true, file });
    } catch (error) {
      res.status(error?.status || 400).json({ ok: false, error: { message: error?.message || String(error) } });
    }
  });

  app.post("/api/resources/replacement", async (req, res) => {
    try {
      const status = await resources.setResourceReplacement(String(req.body?.resourceId || ""), String(req.body?.file || ""));
      res.json({ ok: true, status });
    } catch (error) {
      res.status(error?.status || 400).json({ ok: false, error: { message: error?.message || String(error) } });
    }
  });

  app.post("/api/resources/install", (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const packs = Array.isArray(req.body?.packs) ? req.body.packs : [];
      if (!ids.length && !packs.length) throw new Error("请选择要安装的资源或功能包");
      res.json({ ok: true, job: resources.install({ ids, packs }) });
    } catch (error) {
      res.status(400).json({ ok: false, error: { message: error.message } });
    }
  });

  app.get("/api/resources/jobs/:id", (req, res) => {
    const job = resources.getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: { message: "任务不存在" } });
    res.json({ ok: true, job });
  });

  app.post("/api/resources/jobs/:id/cancel", (req, res) => {
    const job = resources.cancelJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: { message: "任务不存在" } });
    res.json({ ok: true, job });
  });

  app.post("/api/resources/refresh", async (_req, res) => {
    try {
      res.json(await resources.refresh());
    } catch (error) {
      res.status(500).json({ ok: false, error: { message: error.message } });
    }
  });

  app.post("/api/resources/packs/:id/main-model", async (req, res) => {
    try {
      res.json({ ok: true, status: await resources.setMainModel(req.params.id, req.body?.file) });
    } catch (error) {
      res.status(400).json({ ok: false, error: { message: error.message } });
    }
  });

  app.get("/api/skin-unlocks", (_req, res) => {
    res.json({ ok: true, unlocked: skinUnlocks.list(), entries: skinUnlocks.entries() });
  });

  // 「应用」原先只存在浏览器 localStorage，换浏览器或清缓存就没了。
  // 落到网关后跟着数据目录走，多端和重装都能拿回来。
  app.get("/api/workflow-apps", (_req, res) => {
    res.json({ apps: workflowApps.list() });
  });

  app.post("/api/workflow-apps", async (req, res) => {
    const app = await workflowApps.save(req.body?.app || req.body);
    res.json({ app });
  });

  app.delete("/api/workflow-apps/:id", async (req, res) => {
    const removed = await workflowApps.remove(req.params.id);
    if (!removed) throw new HttpError("应用不存在", { status: 404, code: "workflow_app_not_found" });
    res.json({ ok: true });
  });

  // ---- 故事分镜导演台 ----
  // 数据落在网关而不是浏览器：分镜表是长周期编辑的产物，
  // 换浏览器或清缓存就没了等于白做。
  app.get("/api/storyboards", (_req, res) => {
    res.json({ projects: storyboards.list() });
  });

  app.get("/api/storyboards/:id", (req, res) => {
    const project = storyboards.get(req.params.id);
    if (!project) throw new HttpError("分镜项目不存在", { status: 404, code: "storyboard_not_found" });
    res.json({ project });
  });

  app.post("/api/storyboards", async (req, res) => {
    const project = await storyboards.save(req.body?.project || req.body);
    res.status(201).json({ project });
  });

  app.put("/api/storyboards/:id", async (req, res) => {
    const project = await storyboards.save({ ...(req.body?.project || req.body), id: req.params.id });
    res.json({ project });
  });

  app.delete("/api/storyboards/:id", async (req, res) => {
    const removed = await storyboards.remove(req.params.id);
    if (!removed) throw new HttpError("分镜项目不存在", { status: 404, code: "storyboard_not_found" });
    res.json({ ok: true });
  });

  // 导出成 ComfyUI 原生导演台能吃的 storyboard_json，方便把整份项目搬回去跑批量队列。
  app.get("/api/storyboards/:id/comfy-json", (req, res) => {
    const board = storyboards.toComfyStoryboard(req.params.id);
    if (!board) throw new HttpError("分镜项目不存在", { status: 404, code: "storyboard_not_found" });
    res.json({ storyboardJson: JSON.stringify(board) });
  });

  app.post("/api/storyboards/breakdown", async (req, res) => {
    const body = req.body || {};
    try {
      const board = await storyboardAi.breakdown({
        story: body.story,
        style: body.style,
        maxShotSeconds: body.maxShotSeconds,
        targetShotCount: body.targetShotCount,
        // 默认走本机 llama.cpp：本地 ComfyUI 渠道没有 chat 接口，
        // 要求云端 key 会让这个功能在默认配置下永远不可用。
        engine: body.engine === "cloud" ? "cloud" : "local",
        cloud: body.cloud,
      });
      res.json({ board });
    } catch (error) {
      throw new HttpError(error?.message || "AI 拆解失败", { status: error?.status || 502, code: error?.code || "storyboard_ai_failed", details: error?.details });
    }
  });

  // ---- 无限・卷轴（小说工程）----
  // 四层结构：总纲 → 分卷 → 章纲 → 正文，加角色/记忆/分卷。
  // 存网关的理由和分镜一样：几十万字正文清一次缓存就没了等于白做。
  app.get("/api/novels", (_req, res) => {
    res.json({ novels: novels.list() });
  });

  app.get("/api/novels/:id", (req, res) => {
    const novel = novels.get(req.params.id);
    if (!novel) throw new HttpError("小说项目不存在", { status: 404, code: "novel_not_found" });
    res.json({ novel });
  });

  app.post("/api/novels", async (req, res) => {
    const body = req.body || {};
    const novel = await novels.create({ name: body.name, idea: body.idea });
    res.status(201).json({ novel });
  });

  app.put("/api/novels/:id", async (req, res) => {
    const novel = await novels.update(req.params.id, req.body || {});
    if (!novel) throw new HttpError("小说项目不存在", { status: 404, code: "novel_not_found" });
    res.json({ novel });
  });

  app.delete("/api/novels/:id", async (req, res) => {
    const removed = await novels.remove(req.params.id);
    if (!removed) throw new HttpError("小说项目不存在", { status: 404, code: "novel_not_found" });
    res.json({ ok: true });
  });

  // 生成一层。step: outline | volumes | chapters | write | extend
  // write 支持指定 chapterId，只写那一章（正文一次一章是硬约束，见 novel-ai.js）。
  app.post("/api/novels/:id/generate", async (req, res) => {
    const id = req.params.id;
    const project = novels.get(id);
    if (!project) throw new HttpError("小说项目不存在", { status: 404, code: "novel_not_found" });
    const body = req.body || {};
    const step = String(body.step || "outline").toLowerCase();
    const engine = body.engine === "cloud" ? "cloud" : "local";
    const cloud = body.cloud;
    const idea = body.idea !== undefined ? String(body.idea) : project.idea;
    try {
      if (step === "outline") {
        const data = await novelAi.outline({ idea, cloud, engine });
        const novel = await novels.update(id, {
          // 用户没填书名时用模型给的名字，省得还要手动改一次。
          name: project.name === "未命名小说" && data.title ? data.title : project.name,
          structure: { ...project.structure, outline: data.outline },
        });
        res.json({ novel, outline: data });
        return;
      }
      if (step === "volumes") {
        const list = await novelAi.volumes({ idea, structure: project.structure, volumeCount: body.volumeCount, cloud, engine });
        const novel = await novels.update(id, {
          volumes: list,
          structure: { ...project.structure, volumes: list.map((v) => `第${v.seq}卷《${v.title}》：${v.outline}`).join("\n\n") },
        });
        res.json({ novel, volumes: list });
        return;
      }
      if (step === "chapters") {
        const list = await novelAi.chapters({ idea, structure: project.structure, volumes: project.volumes, chapterCount: body.chapterCount, cloud, engine });
        // 合并而不是覆盖：已经写了正文的章节不能被一次重新生成抹掉。
        const bySeq = new Map(project.chapters.map((c) => [c.seq, c]));
        for (const item of list) {
          const existing = bySeq.get(item.seq);
          bySeq.set(item.seq, existing ? { ...item, id: existing.id, novel: existing.novel, status: existing.novel ? "done" : "outlined" } : item);
        }
        const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        const novel = await novels.update(id, {
          chapters: merged,
          structure: { ...project.structure, chapters: merged.map((c) => `第${c.seq}章《${c.title}》：${c.outline}`).join("\n\n") },
        });
        res.json({ novel, chapters: merged });
        return;
      }
      if (step === "write") {
        const target = body.chapterId
          ? project.chapters.find((c) => c.id === body.chapterId)
          : project.chapters.filter((c) => c.outline).find((c) => !c.novel);
        if (!target) throw new HttpError("没有待写的章节（都写完了，或章纲还空着）", { status: 400, code: "novel_no_pending_chapter" });
        const volume = project.volumes.find((v) => v.seq === target.volume) || null;
        const bodyText = await novelAi.chapterBody({
          idea, structure: project.structure, volume, chapter: target,
          context: novels.contextBlock(id), targetWords: body.targetWords, cloud, engine,
        });
        const chapters = project.chapters.map((c) => (c.id === target.id ? { ...c, novel: bodyText, status: "done" } : c));
        const novel = await novels.update(id, { chapters });
        res.json({ novel, chapter: chapters.find((c) => c.id === target.id) });
        return;
      }
      throw new HttpError(`不支持的生成步骤：${step}`, { status: 400, code: "novel_bad_step" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(error?.message || "生成失败", { status: error?.status || 502, code: error?.code || "novel_ai_failed", details: error?.details });
    }
  });

  // 搬家包：把自由卡片和应用连同工作流本体、依赖清单打成一个 JSON。
  // 导出即下载，导入前先预检——用户要知道会装什么、缺什么，再决定点不点。
  app.get("/api/bundles/export", async (req, res) => {
    const listParam = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
    try {
      const bundle = await bundles.buildBundleFor({
        cardIds: listParam(req.query.cards),
        appIds: listParam(req.query.apps),
        exportedBy: req.query.as,
      });
      res.json({ ok: true, bundle });
    } catch (error) {
      throw new HttpError(error.message, { status: error.status || 400, code: error.code || "bundle_export_failed" });
    }
  });

  app.post("/api/bundles/preview", async (req, res) => {
    try {
      res.json({ ok: true, preview: await bundles.previewBundle(req.body?.bundle ?? req.body) });
    } catch (error) {
      throw new HttpError(error.message, { status: error.status || 400, code: error.code || "bundle_preview_failed", details: error.details });
    }
  });

  app.post("/api/bundles/import", async (req, res) => {
    try {
      const result = await bundles.importBundle(req.body?.bundle ?? req.body, { skipDuplicates: req.body?.skipDuplicates !== false });
      res.status(201).json({ ok: true, result });
    } catch (error) {
      throw new HttpError(error.message, { status: error.status || 400, code: error.code || "bundle_import_failed", details: error.details });
    }
  });

  app.post("/api/skin-unlocks", async (req, res) => {
    const entry = await skinUnlocks.unlock(req.body?.skinId);
    res.json({ ok: true, unlocked: skinUnlocks.list(), entry });
  });

  app.get("/api/loras", (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const loras = setup.loraNames().filter((name) => !q || name.toLowerCase().includes(q));
    res.json({ ok: true, loras });
  });

  app.get("/api/system/stats", async (_req, res) => {
    const stats = await readSystemStats();
    const setupStatus = setup.status();
    const taskOOM = tasks.list().find((task) => /out of memory|CUDA OOM|\bOOM\b|allocation on device/i.test(task.error || ""));
    res.json({
      ok: true,
      ...stats,
      comfy: { url: comfy.baseUrl(), reachable: setupStatus.comfyReachable },
      setup: { phase: setupStatus.phase, counts: setupStatus.counts, scannedAt: setupStatus.scannedAt },
      restartAvailable: Boolean(config.launcherControlUrl),
      lastOOM: lastOOM || (taskOOM ? { at: taskOOM.completedAt, message: taskOOM.error } : null),
    });
  });

  app.post("/api/system/free-memory", async (_req, res) => {
    if (!setup.status().comfyReachable) {
      throw new HttpError("ComfyUI 当前不可达，无法清理显存", { status: 503, code: "comfy_unreachable" });
    }
    const before = await readSystemStats({ cacheMs: 0 });
    const started = Date.now();
    await comfy.freeMemory();
    const beforeVram = before.gpu?.[0]?.memoryUsedMb || 0;
    let after = before;
    let lastVram = beforeVram;
    let stable = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(300);
      after = await readSystemStats({ cacheMs: 0 });
      const used = after.gpu?.[0]?.memoryUsedMb || 0;
      if (beforeVram === 0 || used <= Math.max(0, beforeVram - 256)) break;
      stable = Math.abs(used - lastVram) <= 8 ? stable + 1 : 0;
      lastVram = used;
      if (stable >= 2 && Date.now() - started >= 900) break;
    }
    const afterVram = after.gpu?.[0]?.memoryUsedMb || 0;
    const freedRamBytes = Math.max(0, before.ram.usedBytes - after.ram.usedBytes);
    res.json({
      ok: true,
      before,
      after,
      freedVramMb: Math.max(0, beforeVram - afterVram),
      freedRamBytes,
      durationMs: Date.now() - started,
    });
  });

  app.use("/api/update", (req, res, next) => {
    if (!config.desktopDistribution) return next();
    if (req.method === "GET") return res.json({
      ok: true, enabled: false, updateAvailable: false, canApply: false, forceAvailable: false,
      currentVersion: config.version, pending: false, progress: null,
      applyReason: "桌面安装版请通过新的安装包升级，不使用源码补丁更新。",
    });
    res.status(409).json({ ok: false, error: { code: "desktop_update_disabled", message: "桌面安装版不允许源码补丁更新或恢复，请通过安装包升级。" } });
  });

  app.get("/api/update/check", async (req, res) => {
    const fetchRemote = req.query.fetch === "1" || req.query.fetch === "true";
    res.json(await checkForUpdate(config, { fetchRemote }));
  });

  app.get("/api/update/progress", (_req, res) => {
    res.json({ ok: true, progress: getUpdateProgress() });
  });

  app.get("/api/update/recovery", async (_req, res) => {
    const { backupDir: _backupDir, ...info } = await detectInterruptedUpdate(config);
    res.json({ ok: true, ...info });
  });

  app.post("/api/update/recovery/restore", async (_req, res) => {
    res.json({ ok: true, ...(await restoreInterruptedUpdate(config)) });
  });

  app.post("/api/update/apply", async (req, res) => {
    const active = tasks.list().some((task) => ["queued", "running"].includes(task.status));
    if (active) {
      throw new HttpError("有正在运行的生成任务，请等待完成或取消后再更新", { status: 409, code: "tasks_running" });
    }
    res.json(await applyUpdate(config, { dryRun: req.body?.dryRun === true, force: req.body?.force === true }));
  });

  app.post("/api/system/restart-comfy", async (_req, res) => {
    if (!config.launcherControlUrl) {
      throw new HttpError("启动器未运行，无法自动重启 ComfyUI", { status: 503, code: "launcher_unavailable" });
    }
    try {
      const response = await fetch(`${config.launcherControlUrl}/restart-comfy`, {
        method: "POST",
        signal: AbortSignal.timeout(360000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new HttpError(data.error || "重启 ComfyUI 失败", { status: 502, code: "restart_failed", details: data });
      }
      lastOOM = null;
      res.json(data);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(`无法联系启动器：${error.message}`, { status: 503, code: "launcher_unreachable" });
    }
  });

  app.post("/api/system/shutdown", (req, res) => {
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      throw new HttpError("仅允许本机发起关停请求", { status: 403, code: "shutdown_forbidden" });
    }
    if (typeof app.locals.requestShutdown !== "function") {
      throw new HttpError("当前网关不是由启动器托管的主进程，无法自动关停", { status: 409, code: "shutdown_unavailable" });
    }
    res.json({ ok: true });
    setTimeout(() => app.locals.requestShutdown(), 30);
  });

  app.post("/api/agent/provider", (req, res) => {
    // Installed desktop uses the native-protocol cloud gateway, not the optional
    // source-editing pi runtime. Never persist keys into its read-only appRoot.
    if (config.desktopDistribution) {
      throw new HttpError("桌面版云端 Agent 无需写入 pi 运行时配置，请使用配置与用户偏好中的云端 API。", { status: 409, code: "desktop_provider_sync_disabled" });
    }
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      throw new HttpError("仅允许本机同步 Agent API", { status: 403, code: "provider_forbidden" });
    }
    const origin = String(req.headers.origin || "");
    if (origin) {
      let host = "";
      try {
        host = new URL(origin).hostname.toLowerCase();
      } catch {}
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
        throw new HttpError("仅允许本机 origin 同步 Agent API", { status: 403, code: "provider_origin_forbidden" });
      }
    }
    const value = req.body && typeof req.body === "object" ? req.body : {};
    const providerFile = path.join(config.appRoot, "assistant", "agent-provider.json");
    if (value.clear === true) {
      fs.rmSync(providerFile, { force: true });
      logger.info?.("Agent provider cleared");
      res.json({ ok: true, cleared: true });
      return;
    }
    let baseUrl = "";
    try {
      const parsed = new URL(String(value.baseUrl || "").trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      baseUrl = parsed.toString().replace(/\/+$/, "");
    } catch {
      throw new HttpError("API 地址无效（只支持 http/https）", { status: 400, code: "provider_base_url_invalid" });
    }
    const apiKey = String(value.apiKey || "").trim();
    const model = String(value.model || "").trim();
    const label = String(value.label || "").trim();
    if (!apiKey) throw new HttpError("缺少 API Key", { status: 400, code: "provider_key_missing" });
    if (!model) throw new HttpError("缺少 API 模型", { status: 400, code: "provider_model_missing" });
    fs.mkdirSync(path.dirname(providerFile), { recursive: true });
    const temp = `${providerFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ baseUrl, apiKey, model, label, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, providerFile);
    logger.info?.("Agent provider updated (key redacted)");
    res.json({ ok: true, model, label });
  });

  app.get("/api/assistant/status", async (_req, res) => {
    res.json(await assistant.status());
  });

  app.post("/api/assistant/ensure", async (req, res) => {
    const result = await assistant.ensure({ download: req.body?.download === true });
    res.status(result.ok ? 200 : result.needFullPackage ? 409 : 503).json(result);
  });

  app.post("/api/assistant/stop", async (_req, res) => {
    res.json(await assistant.stop("api-request"));
  });

  app.post("/api/setup/scan", (_req, res) => {
    void setup.scan().catch((error) => logger.warn(`manual setup scan failed: ${error.message}`));
    res.json({ ok: true, status: setup.status() });
  });

  async function setLauncherComfyDir(dir) {
    if (config.launcherControlUrl) {
      try {
        const response = await fetch(`${config.launcherControlUrl}/set-comfy-dir`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dir }),
        });
        if (response.ok) return true;
        logger.warn(`启动器拒绝更新 ComfyUI 目录：HTTP ${response.status}`);
      } catch (error) {
        logger.warn(`通知启动器更新 ComfyUI 目录失败：${error.message}`);
      }
    }
    try {
      const file = config.launcherConfigPath || path.join(config.appRoot, "launcher", "config.json");
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : {};
      data.comfyDir = dir;
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      return true;
    } catch (error) {
      logger.warn(`写入 launcher/config.json 失败：${error.message}`);
      return false;
    }
  }

  let pickerBusy = false;

  app.post("/api/setup/pick-directory", async (req, res) => {
    if (config.allowRemote) throw new HttpError("远程模式不支持原生目录选择，请手动输入路径", { status: 400, code: "picker_remote_disabled" });
    if (process.platform !== "win32" && !process.env.FOLDER_PICKER_FAKE) {
      throw new HttpError("当前系统不支持原生目录选择，请手动输入路径", { status: 400, code: "picker_unsupported" });
    }
    if (pickerBusy) throw new HttpError("已有目录选择窗口打开，请先完成或取消", { status: 409, code: "picker_busy" });
    pickerBusy = true;
    try {
      const result = await pickFolder({
        title: String(req.body?.title || "选择文件夹"),
        initial: String(req.body?.initial || ""),
      });
      res.json({ ok: true, ...result });
    } finally {
      pickerBusy = false;
    }
  });

  app.get("/api/setup/directories", (_req, res) => {
    const liveRoot = resources.comfyRoot?.() || config.comfyDir || "";
    const settings = setup.getDirectorySettings();
    const auto = describeAutoDirectories({ comfyRoot: liveRoot, workflowsDir: config.comfyWorkflowsDir });
    const setupStatus = setup.status();
    const loadReport = directoryLoadReport(settings, { comfyRoot: liveRoot, folderPaths: setup.folderPaths?.() || {} });
    res.json({
      ok: true,
      settings,
      comfyRoot: liveRoot,
      auto,
      loadReport,
      setup: { phase: setupStatus.phase, counts: setupStatus.counts, comfyReachable: setupStatus.comfyReachable },
    });
  });

  app.post("/api/setup/directories/scan", (req, res) => {
    const settings = normalizeDirectorySettings({ ...(req.body || {}), mode: "manual" });
    const validation = validateDirectorySettings(settings);
    if (!validation.ok) throw new HttpError(validation.errors.join("；"), { status: 400, code: "invalid_directories", details: validation.errors });
    res.json({ ok: true, scan: scanDirectories(settings), validation });
  });

  app.post("/api/setup/directories", async (req, res) => {
    const body = req.body || {};
    const settings = normalizeDirectorySettings({ ...body, mode: body.mode === "auto" ? "auto" : "manual" });
    const validation = validateDirectorySettings(settings);
    if (!validation.ok) throw new HttpError(validation.errors.join("；"), { status: 400, code: "invalid_directories", details: validation.errors });
    const previous = setup.getDirectorySettings();
    const liveRootBefore = resources.comfyRoot?.() || setup.comfyRootForScan() || config.comfyDir;
    const saved = await saveDirectorySettings(config.dataDir, settings);
    setup.setDirectorySettings(saved);
    const liveRoot = liveRootBefore;
    const manualRoot = saved.mode === "manual" && saved.comfyDir ? detectComfyLayout(saved.comfyDir)?.root || saved.comfyDir : "";
    const targetRoot = manualRoot || liveRoot;
    const yamlSettings = saved.mode === "manual" ? saved : { ...saved, modelDirs: [], loraDirs: [], customNodesDirs: [] };
    const write = writeManagedExtraPaths(targetRoot, yamlSettings);
    resources.invalidate?.();
    // 换目录或切回自动时，把旧目录里的托管块也清掉，避免以后又切回去时残留旧路径。
    if (previous.mode === "manual" && previous.comfyDir && previous.comfyDir !== saved.comfyDir) {
      const previousRoot = detectComfyLayout(previous.comfyDir)?.root || previous.comfyDir;
      if (previousRoot !== targetRoot) {
        writeManagedExtraPaths(previousRoot, { ...previous, modelDirs: [], loraDirs: [], customNodesDirs: [] });
      }
    }
    const launcherUpdated = saved.mode === "manual" && saved.comfyDir ? await setLauncherComfyDir(saved.comfyDir) : false;
    const scan = scanDirectories(saved);
    // 用 live 的 folder_paths 判断是否已在 ComfyUI 清单里，避免用上次扫描的旧结果误报“需重启”。
    const liveFolderPaths = await comfy.folderPaths().catch(() => setup.folderPaths?.() || {});
    const loadReport = directoryLoadReport(saved, { comfyRoot: liveRootBefore, folderPaths: liveFolderPaths });
    const restartRequired = saved.mode === "manual" && (loadReport.restartRequired || Boolean(write.changed));
    await setup.scan("directories").catch((error) => logger.warn(`directory settings rescan failed: ${error.message}`));
    res.json({
      ok: true,
      settings: saved,
      comfyRoot: targetRoot,
      write,
      scan,
      loadReport,
      launcherUpdated,
      restartRequired,
      note: saved.mode === "auto"
        ? "已切回自动识别，手动目录已从 extra_model_paths.yaml 移除。"
        : restartRequired
          ? "新目录不在 ComfyUI 当前清单中；已写入 extra_model_paths.yaml，重启 ComfyUI 后生效，资源卡与工作流可用性也会在重启后刷新。"
          : "目录已在 ComfyUI 当前清单中，无需重启；已重新扫描，资源卡会直接更新。",
    });
  });

  app.post("/api/session/open", (req, res) => {
    res.json({ ok: true, ...sessions.touch(req.body?.id) });
  });

  app.post("/api/session/heartbeat", (req, res) => {
    res.json({ ok: true, ...sessions.touch(req.body?.id) });
  });

  app.post("/api/session/close", (req, res) => {
    res.json({ ok: true, ...sessions.close(req.body?.id) });
  });

  app.get("/api/session/status", (_req, res) => {
    const activeTasks = tasks.list().filter((task) => task.status === "queued" || task.status === "running").length;
    res.json({ ok: true, ...sessions.status(), activeTasks });
  });

  app.post("/api/requests/:id/cancel", (req, res) => {
    const controller = activeRequests.get(String(req.params.id || ""));
    if (controller) controller.abort("client-cancel");
    res.json({ ok: true, cancelled: Boolean(controller) });
  });

  app.get("/admin", (_req, res) => {
    // Use a fixed relative filename: desktop development lives below .build,
    // which sendFile otherwise treats as a forbidden dotfile path component.
    res.sendFile("admin.html", { root: path.join(config.rootDir, "src"), dotfiles: "deny" });
  });

  app.get("/api/tasks", (req, res) => {
    res.json({
      tasks: tasks.list().slice(0, 50).map((task) => ({
        ...task,
        url: task.url ? absoluteTaskUrl(config, req, task.url) : null,
      })),
    });
  });

  app.get("/api/models/events", (req, res) => {
    modelEvents.subscribe(req, res);
  });

  app.get("/v1/models", async (_req, res) => {
    await reloadRegistryAndSnapshot();
    const status = setup.status();
    const degraded = status.phase === "degraded";
    const data = registry
      .listModels((setup.loaderOptions?.() || {}))
      .filter((model) => (setup.isAvailable(model.baseId) || (degraded && setup.isKnownAvailable?.(model.baseId))) && !model.entry.hidden && model.entry.category !== "upscale" && !workflowVisibility.isHidden(model.entry.id))
      .map((model) => ({
        id: model.modelId,
        object: "model",
        created: 0,
        owned_by: "local-comfyui",
        metadata: {
          type: model.entry.type,
          workflowId: model.entry.id,
          label: model.entry.baseModel
            ? `${model.entry.label || model.entry.name} · ${model.entry.baseModelLabel || "variant"}`
            : model.entry.label || model.entry.name,
          baseModel: model.entry.baseModel || null,
          baseModelLabel: model.entry.baseModelLabel || null,
          imageInputs: imageInputCapacity(model.entry),
          description: model.entry.description || "",
          variantModes: model.entry.variants ? Object.keys(model.entry.variants) : [],
          variantLabels: model.entry.variantLabels || {},
          parameters: enrichParameters(model.entry.parameters),
          availability: setup.workflowStatus(model.baseId),
        },
      }));
    res.json({ object: "list", revision: modelEvents.snapshot().revision, setup: setupSyncSummary(status), data });
  });

  app.get("/api/workflows", async (_req, res) => {
    await reloadRegistryAndSnapshot();
    res.json({
      workflows: registry.list().map((entry) => ({
        ...entry,
        enabled: entry.hidden !== true && !workflowVisibility.isHidden(entry.id),
        availability: setup.workflowStatus(entry.id),
      })),
    });
  });

  app.post("/api/workflows/:id/visibility", async (req, res) => {
    const entry = registry.resolve(req.params.id);
    if (!entry) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    if (entry.hidden) throw new HttpError("该工作流由内置规则隐藏，不能修改", { status: 400, code: "workflow_internal" });
    const enabled = req.body?.enabled !== false;
    await workflowVisibility.setHidden(entry.id, !enabled);
    logger.info(`workflow visibility ${entry.id} -> ${enabled ? "enabled" : "hidden"}`);
    emitModelChange("visibility");
    res.json({ ok: true, id: entry.id, enabled });
  });

  app.post("/api/workflows/:id/label", async (req, res) => {
    const entry = registry.resolve(req.params.id);
    if (!entry) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    // 传空字符串表示恢复 registry.json 里的默认显示名。
    const label = workflowLabels.normalize(req.body?.label);
    if (label && label.length > workflowLabels.MAX_LABEL_LENGTH) {
      throw new HttpError(`显示名不能超过 ${workflowLabels.MAX_LABEL_LENGTH} 个字符`, { status: 400, code: "invalid_label" });
    }
    await workflowLabels.set(entry.id, label);
    // label 存在独立文件里，registry 的文件签名不会变，必须显式重载才能生效。
    await registry.load();
    const updated = registry.resolve(entry.id);
    logger.info(`workflow label ${entry.id} -> ${label || "(默认)"}`);
    emitModelChange("label");
    res.json({ ok: true, id: entry.id, label: updated?.label || entry.name, custom: Boolean(label) });
  });

  async function liveModelInfo() {
    try {
      const info = await comfy.objectInfo();
      if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("object_info 格式无效");
      return info;
    } catch {
      throw new HttpError("ComfyUI 不可达，模型配置当前只读", { status: 503, code: "workflow_models_offline" });
    }
  }

  app.get("/api/workflows/:id/models", async (req, res) => {
    const entry = registry.resolve(req.params.id);
    assertModelConfigurable(entry);
    let info = {}, offline = false;
    try { info = await liveModelInfo(); } catch { offline = true; }
    res.json(workflowModelFields(entry, info, { offline }));
  });

  let modelConfigPending = Promise.resolve();
  app.patch("/api/workflows/:id/models", async (req, res) => {
    // 配置修改到快照刷新按请求串行完成，避免并发 PATCH 返回旧图或丢失字段。
    const operation = modelConfigPending.catch(() => {}).then(async () => {
      const entry = registry.resolve(req.params.id);
      assertModelConfigurable(entry);
      const info = await liveModelInfo();
      const patch = validateWorkflowModelPatch(entry, req.body, info);
      await workflowModels.update(entry.id, patch);
      await registry.load({ force: true });
      await setup.scan("workflow-models");
      if (!setup.registrySnapshotCurrent() && setup.status().comfyReachable) await setup.scan("workflow-models");
      emitModelChange("workflow-models");
      return { ok: true, ...workflowModelFields(registry.resolve(entry.id), info) };
    });
    modelConfigPending = operation;
    res.json(await operation);
  });

  // 更新已注册工作流：改名称/类型/描述/绑定/参数，或替换工作流 JSON 内容。
  app.patch("/api/workflows/:id", async (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const key of ["name", "label", "type", "description", "bindings", "defaults", "presets", "parameters", "lora", "json"]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (!Object.keys(patch).length) throw new HttpError("没有需要更新的字段", { status: 400, code: "empty_patch" });
    const result = await registry.updateWorkflow(req.params.id, patch);
    await setup.scan("registry-update");
    logger.info(`updated workflow ${result.workflow.id}`);
    emitModelChange("registry-update");
    res.json({ ok: true, ...result });
  });

  app.get("/api/workflows/:id", (req, res) => {
    const entry = registry.resolve(req.params.id);
    if (!entry) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    res.json({ workflow: registry.publicEntry(entry), schema: registry.schema(entry) });
  });

  app.get("/api/workflows/:id/schema", (req, res) => {
    const found = registry.resolveModel(req.params.id, (setup.loaderOptions?.() || {}));
    if (!found) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    const schema = registry.schema(found.entry);
    res.json({ schema: { ...schema, parameters: enrichParameters(schema.parameters) } });
  });

  app.get("/api/upscale/workflows", (_req, res) => {
    const workflows = registry
      .list()
      .filter((entry) => entry.category === "upscale" && entry.type === "image")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        label: entry.label || entry.name,
        description: entry.description || "",
        available: setup.isAvailable(entry.id),
        problems: setup.workflowStatus(entry.id).problems || [],
        parameters: enrichParameters(entry.parameters),
      }));
    res.json({ workflows });
  });

  app.post("/api/workflows/import", async (req, res) => {
    const result = await registry.importWorkflow(req.body || {});
    await setup.scan("registry-import");
    logger.info(`imported workflow ${result.workflow.name} (${result.workflow.type})`);
    res.status(201).json({ ok: true, ...result });
  });

  app.post("/api/workflows/scan", async (_req, res) => {
    const result = await registry.scan();
    await setup.scan("registry-scan");
    res.json({ ok: true, ...result });
  });

  app.post("/api/workflows/reload", async (_req, res) => {
    await registry.load();
    await setup.scan("registry-reload");
    res.json({ ok: true, count: registry.list().length });
  });

  app.delete("/api/workflows/:id", async (req, res) => {
    // keepFile=1 只取消注册、保留工作流文件；默认连文件一起删，否则扫描会把它重新导入。
    const keepFile = req.query.keepFile === "1" || req.body?.keepFile === true;
    const removed = await registry.remove(req.params.id, { keepFile });
    if (!removed) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    await setup.scan("registry-remove");
    emitModelChange("registry-remove");
    res.json({ ok: true, keepFile });
  });

  const requireFreeWorkflow = (id) => {
    const entry = freeWorkflows.get(id);
    if (!entry) throw new HttpError("自由卡片不存在", { status: 404, code: "free_workflow_not_found" });
    return entry;
  };

  app.get("/api/free-workflows/sources", async (_req, res) => {
    const resolved = await resolveFreeWorkflowsDir();
    res.json({
      sources: await freeWorkflows.listSources(),
      dir: resolved.dir || config.comfyWorkflowsDir || "",
      comfyDir: config.comfyDir || "",
      tried: resolved.tried,
    });
  });

  app.get("/api/free-workflows", async (req, res) => {
    const archived = req.query.archived === "1" || req.query.archived === "true";
    res.json({ workflows: await freeWorkflows.list(archived ? { archived: true } : {}) });
  });

  app.post("/api/free-workflows/import", async (req, res) => {
    await resolveFreeWorkflowsDir();
    const relative = String(req.body?.path || "").trim();
    if (!relative) throw new HttpError("缺少工作流路径", { status: 400, code: "missing_workflow_path" });
    try {
      const entry = await freeWorkflows.importSource(relative);
      res.status(201).json({ workflow: await freeWorkflows.publicEntry(entry) });
    } catch (error) {
      throw new HttpError(`导入工作流失败：${error.message}`, { status: 400, code: "free_workflow_import_failed", details: error.details });
    }
  });

  // 直接上传 JSON 导入自由卡（前端「导入对话框」用）。
  app.post("/api/free-workflows/import-upload", express.json({ limit: "8mb" }), async (req, res) => {
    try {
      const entry = await freeWorkflows.importUploaded(req.body?.name, req.body?.content);
      res.json({ workflow: await freeWorkflows.publicEntry(entry) });
    } catch (error) {
      throw new HttpError(`工作流导入失败：${error.message}`, { status: 400, code: "free_workflow_import_failed" });
    }
  });
  app.get("/api/free-workflows/:id", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.get("/api/free-workflows/:id/ui", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    try {
      res.json(await freeWorkflows.readRawWorkflow(entry));
    } catch (error) {
      const message = /ENOENT/.test(String(error.message)) ? "源工作流文件已不存在，可能已在 ComfyUI 中删除" : error.message;
      throw new HttpError(`读取工作流失败：${message}`, { status: 409, code: "free_workflow_read_failed" });
    }
  });

  /**
   * 简化节点图：给画布内嵌的可视化用。
   *
   * 输出的是「节点 + 可绑定的输入」，不是完整工作流——用户只需要认出
   * 「哪个节点里的哪个参数」，不需要看懂整张图。
   */
  app.get("/api/free-workflows/:id/graph", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    const objectInfo = await comfy.objectInfo().catch(() => ({}));
    res.json({
      graph: describeWorkflowGraph(entry.workflow, objectInfo),
      customBindings: (entry.customBindings || []).map(publicBinding),
    });
  });

  // G8/G9：完整图描述（节点位置+连线+参数），供「流程分页 + 参数披露」使用。
  // flowId 为空时用主流程；与上面的简化图并存，互不影响。
  app.get("/api/free-workflows/:id/full-graph", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    res.json({ graph: await freeWorkflows.graph(entry, String(req.query.flowId || "")) });
  });

  // G9：写入参数披露项（保留用户已有的值，不覆盖同 key 的已改值）。
  // 参数披露写入：上游契约用 PUT，本地前端沿用 POST，这里两个方法都接。
  app.put("/api/free-workflows/:id/params", async (req, res) => {
    const entry = await freeWorkflows.setParams(req.params.id, req.body?.params);
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.post("/api/free-workflows/:id/params", async (req, res) => {
    const entry = await freeWorkflows.setParams(req.params.id, req.body?.params);
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  // G7：干跑校验（不提交、不跑 GPU）。
  app.post("/api/free-workflows/:id/validate", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    res.json(await freeWorkflows.validate(entry, req.body || {}));
  });

  // G10：快照列表 / 创建 / 读取。
  app.post("/api/free-workflows/:id/snapshots", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    const raw = await freeWorkflows.readRawWorkflow(entry).catch(() => null);
    if (!raw) throw new HttpError("源工作流文件不可读，无法创建快照", { status: 409, code: "free_workflow_read_failed" });
    const snapshot = await freeWorkflows.createSnapshot(req.params.id, req.body || {});
    res.json({ snapshot: await freeWorkflows.publicEntry(snapshot) });
  });

  app.get("/api/free-workflows/:id/snapshot", async (req, res) => {
    const snapshot = freeWorkflows.getSnapshot(req.params.id);
    if (!snapshot) throw new HttpError("快照不存在", { status: 404, code: "snapshot_not_found" });
    res.json({ snapshot });
  });
  // 工作流体检（只读）：缺自定义节点 / combo 值不在选项 / 必填为空 / 不可达输出。
  // 不提交 ComfyUI，不跑 GPU；用于导入后与生成前的静态诊断。
  app.get("/api/free-workflows/:id/health", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    const objectInfo = await comfy.objectInfo().catch(() => ({}));
    const problems = detectWorkflowProblems(entry.workflow, objectInfo);
    const missingNodes = [...new Set(problems.filter((item) => !item.input).map((item) => item.title))];
    res.json({
      issues: problems,
      missingNodes,
      flowId: String(req.query.flowId || ""),
    });
  });

  // 固定到卡片上的配置项。只接受工作流里真实存在且未被连线的输入。
  app.patch("/api/free-workflows/:id/bindings", async (req, res) => {    const entry = requireFreeWorkflow(req.params.id);
    try {
      const updated = await freeWorkflows.setCustomBindings(entry.id, req.body?.bindings);
      res.json({ workflow: await freeWorkflows.publicEntry(updated) });
    } catch (error) {
      throw new HttpError(`保存固定配置失败：${error.message}`, { status: 400, code: "free_workflow_bindings_failed" });
    }
  });

  app.get("/api/free-workflows/:id/open", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    const source = await freeWorkflows.sourceState(entry);
    if (!source.exists) throw new HttpError("源工作流文件已不存在，无法在 ComfyUI 中编辑", { status: 409, code: "free_workflow_source_missing" });
    const bridge = await comfyBridge.ensure();
    const target = new URL(comfy.baseUrl());
    target.searchParams.set("local_canvas_open", entry.id);
    target.searchParams.set("local_canvas_gw", `${req.protocol}://${req.get("host")}`);
    res.json({
      url: target.toString(),
      name: entry.name,
      sourceRel: entry.sourceRel,
      sourceFormat: entry.sourceFormat,
      bridge: Boolean(bridge.installed),
      bridgeReason: bridge.installed ? undefined : bridge.reason,
    });
  });

  app.post("/api/free-workflows/:id/sync", async (req, res) => {
    try {
      // force：源文件签名没变也重新转换（前端重新扫描时用）。
      const result = await freeWorkflows.sync(req.params.id, Boolean(req.body?.force));
      res.json({ changed: result.changed, workflow: await freeWorkflows.publicEntry(result.entry) });
    } catch (error) {
      throw new HttpError(`同步工作流失败：${error.message}`, { status: 409, code: "free_workflow_sync_failed" });
    }
  });

  // 「新增归档」：把这条卡片连同当前参数快照复制成一条新的，原卡片不受影响。
  app.post("/api/free-workflows/:id/duplicate", async (req, res) => {
    const body = req.body || {};
    try {
      const copy = await freeWorkflows.duplicate(req.params.id, { preset: body.preset, name: body.name, texts: body.texts, values: body.values });
      res.json({ workflow: await freeWorkflows.publicEntry(copy) });
    } catch (error) {
      throw new HttpError(`新增归档失败：${error.message}`, { status: 400, code: "free_workflow_duplicate_failed" });
    }
  });

  app.patch("/api/free-workflows/:id", async (req, res) => {
    const body = req.body || {};
    if ((body.texts !== undefined && !Array.isArray(body.texts)) || (body.values !== undefined && !Array.isArray(body.values))) {
      throw new HttpError("配置值必须是数组", { status: 400, code: "free_workflow_archive_failed" });
    }
    const current = requireFreeWorkflow(req.params.id);
    const archiveRequest = ["archived", "preset", "texts", "values"].some((key) => Object.hasOwn(body, key));
    let entry;
    if (body.name !== undefined && !archiveRequest) {
      entry = await freeWorkflows.rename(current.id, body.name);
    } else {
      const archived = body.archived === undefined ? Boolean(current.archivedAt) : Boolean(body.archived);
      if (archived && body.texts?.length) await freeWorkflows.ensureBindings(current);
      entry = await freeWorkflows.setArchived(current.id, archived, body.preset, { texts: body.texts, values: body.values });
    }
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.delete("/api/free-workflows/:id", async (req, res) => {
    const entry = await freeWorkflows.remove(req.params.id);
    if (!entry) throw new HttpError("自由卡片不存在", { status: 404, code: "free_workflow_not_found" });
    res.json({ ok: true, id: entry.id });
  });

  app.post("/v1/free-workflows/:id/images", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    if (entry.bindings?.outputType !== "image") {
      throw new HttpError("这个自由卡片不是图片工作流", { status: 400, code: "free_workflow_not_image" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    const texts = parseFreeTexts(body.texts);
    const effectivePrompt = freeEffectivePrompt(entry, texts, prompt);
    if (entry.bindings?.prompt && !effectivePrompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    const uploadedImages = await uploadImages(comfy, orderedPromptImages(req.files || []));
    const parsedSize = parseSize(body.size);
    const workflow = applyFreeInputs(entry.workflow, freeWorkflows.executionBindings(entry), {
      prompt: effectivePrompt,
      texts,
      values: parseFreeValues(body.values),
      uploadedImages,
      size: parsedSize ? { width: parsedSize.width, height: parsedSize.height } : undefined,
      count: body.n ?? body.count,
      seed: body.seed,
      seedFixed: body.seedFixed,
      ratio: body.ratio,
    });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry: { name: entry.name, type: "image", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt: effectivePrompt, count: 1 }),
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
        includePreviewOutputs: true,
        logger,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`free image ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const files = result.files.filter((file) => /^image\//i.test(file.mimeType) || /\.(png|jpe?g|webp)$/i.test(file.filename));
    if (!files.length) throw new HttpError("自由工作流没有返回图片", { status: 502, code: "no_images" });
    logger.info(`free image ${entry.name} -> ${result.promptId} (${files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"), file.assetName);
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/free-workflows/:id/videos", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    if (entry.bindings?.outputType !== "video") {
      throw new HttpError("这个自由卡片不是视频工作流", { status: 400, code: "free_workflow_not_video" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    const texts = parseFreeTexts(body.texts);
    const effectivePrompt = freeEffectivePrompt(entry, texts, prompt);
    if (entry.bindings?.prompt && !effectivePrompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    // 视频工作流也可能吃音频：数字人、音频驱动这类靠一段驱动音频决定口型和台词。
    // 前端把参考音频放在 audios 字段，这里必须和图片一起收——否则 applyFreeInputs
    // 拿不到音频，ComfyUI 会去读工作流里写死的旧文件名，报 "Invalid audio file"。
    const uploadedImages = await uploadImages(comfy, orderedPromptImages(req.files || []));
    const uploadedAudios = await uploadImages(comfy, orderedAudioRefFiles(req.files || []));
    const parsedSize = parseSize(body.size);
    const workflow = applyFreeInputs(entry.workflow, freeWorkflows.executionBindings(entry), {
      prompt: effectivePrompt,
      texts,
      values: parseFreeValues(body.values),
      uploadedImages,
      uploadedAudios,
      size: parsedSize ? { width: parsedSize.width, height: parsedSize.height } : undefined,
      count: body.n ?? body.count,
      seed: body.seed,
      seedFixed: body.seedFixed,
      ratio: body.ratio,
    });
    const task = tasks.create({
      model: entry.name,
      request: {
        prompt: effectivePrompt,
        size: body.size,
        images: uploadedImages.map((image) => image.name),
        audios: uploadedAudios.map((audio) => audio.name),
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const result = await runVideo({
        entry: { name: entry.name, type: "video", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt: effectivePrompt, count: 1 }),
        comfy,
        timeoutMs: config.videoTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
        includePreviewOutputs: true,
        onProgress: progress,
        logger,
      });
      const file = result.files[0];
      return {
        buffer: file.buffer,
        assetName: file.assetName,
        ext: extFromMime(file.mimeType, file.filename, "mp4"),
        mimeType: file.mimeType,
        promptId: result.promptId,
      };
    });
    logger.info(`free video ${entry.name} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  // 自由卡片的音频工作流：同步返回，和 /images 一样用 { data: [{ b64_json | url }] }。
  // 与 /v1/audio/speech 的区别在于模型来自自由卡片本身，不需要前端再按 mode 反查工作流。
  app.post("/v1/free-workflows/:id/audio", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    if (entry.bindings?.outputType !== "audio") {
      throw new HttpError("这个自由卡片不是音频工作流", { status: 400, code: "free_workflow_not_audio" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    const texts = parseFreeTexts(body.texts);
    const effectivePrompt = freeEffectivePrompt(entry, texts, prompt);
    if (entry.bindings?.prompt && !effectivePrompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    const uploadedAudios = await uploadImages(comfy, orderedAudioRefFiles(req.files || []));
    const workflow = applyFreeInputs(entry.workflow, freeWorkflows.executionBindings(entry), {
      prompt: effectivePrompt,
      texts,
      values: parseFreeValues(body.values),
      uploadedAudios,
      seed: body.seed,
      seedFixed: body.seedFixed,
    });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runAudio({
        entry: { name: entry.name, type: "audio", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt: effectivePrompt, count: 1, uploadedAudios }),
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
        includePreviewOutputs: true,
        logger,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`free audio ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const file = result.files[0];
    logger.info(`free audio ${entry.name} -> ${result.promptId} ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const item =
      responseFormat === "url"
        ? { url: absoluteTaskUrl(config, req, (await tasks.saveOutput(randomId("aud_"), file.buffer, extFromMime(file.mimeType, file.filename, "flac"))).url) }
        : { b64_json: file.buffer.toString("base64") };
    res.json({ created: Math.floor(Date.now() / 1000), mime_type: file.mimeType || "audio/flac", data: [item] });
  });

  // 上游 v0.25.3 新增的本地音频入口。刻意与下面的 /v1/audio/speech 分开：
  // 老路由走「音色设计/克隆/音乐 + 注册表工作流」，行为完全不变；
  // 这里只提供上游那套「直接拼 ComfyUI 节点图」的台词/写歌能力。
  const sendAudioResult = (res, req, result) => {
    const format = String(req.body?.response_format || "").toLowerCase();
    if (format === "b64_json") {
      return res.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: result.buffer.toString("base64") }], mime_type: result.mimeType });
    }
    res.set("Content-Type", result.mimeType);
    return res.send(result.buffer);
  };

  // 台词：IndexTTS-2 零样本克隆，必须有参考音色。
  app.post("/v1/audio/speech-indextts", upload.any(), async (req, res) => {
    const body = req.body || {};
    const referenceFile = (req.files || []).find((f) => f?.buffer && /reference|audio/i.test(f.fieldname));
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await synthesizeSpeech({
        comfy, config, logger,
        text: String(body.input || body.text || ""),
        seed: body.seed != null ? Number(body.seed) : undefined,
        speed: body.speed != null ? Number(body.speed) : undefined,
        instructions: String(body.instructions || ""),
        referenceFile,
        signal: abort.signal, requestId: req.id,
      });
      return sendAudioResult(res, req, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally { abort.cleanup(); }
  });

  // 台词：MiniMax H3 描述音色语音，不需要参考音频（单段约 15 秒上限）。
  app.post("/v1/audio/speech-h3", async (req, res) => {
    const body = req.body || {};
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await synthesizeSpeechH3({
        comfy, config, logger,
        text: String(body.input || body.text || body.prompt || ""),
        voiceDescription: String(body.voice_description || ""),
        instructions: String(body.instructions || ""),
        language: String(body.language || "zh"),
        seed: body.seed != null ? Number(body.seed) : undefined,
        signal: abort.signal, requestId: req.id,
      });
      return sendAudioResult(res, req, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally { abort.cleanup(); }
  });

  // 写歌 / 纯音乐：ComfyUI 官方 YuE2 节点链。歌词为空即纯音乐（走 InstrumentalConvert 节点）。
  let audioJobActive = null;
  app.post("/v1/audio/song", upload.any(), async (req, res) => {
    const body = req.body || {};
    const files = req.files || [];
    const reference = files.find((file) => file?.buffer && /reference|audio/i.test(file.fieldname || ""));
    if (reference) {
      throw new HttpError("YuE2 写歌不支持参考音色；参考音色仅用于换声", { status: 400, code: "unsupported_reference_audio" });
    }
    const rawPrecision = String(body.precision ?? "").trim().toLowerCase();
    let bf16Installed = null;
    if (rawPrecision === "quality") {
      try {
        const bf16 = resources.status()?.resources?.find((item) => item.id === "yue2_3b_bf16");
        if (bf16) bf16Installed = Boolean(bf16.present);
      } catch {
        bf16Installed = null;
      }
    }
    let yue2Precision;
    try {
      yue2Precision = resolveYue2Precision(body.precision, { envCheckpoint: process.env.YUE2_COMFY_CHECKPOINT, bf16Installed });
    } catch (error) {
      throw new HttpError(error.message, { status: error.status || 400, code: error.code || "invalid_precision", details: error.details });
    }
    const { precision, checkpoint } = yue2Precision;
    const audioModelMissing = () => new HttpError(
      precision === "quality"
        ? "YuE2 质量档模型未就绪：请到资源中心安装 YuE2-3B BF16（yue2_3b_bf16.safetensors）后重试。"
        : "YuE2 模型/节点未就绪：请确认 ComfyUI 0.44+ 已安装原生 YuE2 节点，并把 yue2_3b_int8_convrot.safetensors 放到 models/checkpoints（CC BY-NC 4.0，资源中心/官方下载）。",
      { status: 503, code: "audio_model_missing", details: { engine: "comfyui", ...(precision === "quality" ? { resourceId: "yue2_3b_bf16" } : {}) } },
    );
    const lyrics = String(body.lyrics || body.input || body.prompt || "").trim();
    const instrumentalFlag = body.instrumental;
    const flagOff = instrumentalFlag === false || /^(false|0)$/i.test(String(instrumentalFlag ?? ""));
    const instrumental = !flagOff && (/^(true|1)$/i.test(String(instrumentalFlag ?? "")) || !lyrics);
    if (!instrumental) {
      if (!lyrics) throw new HttpError("缺少歌词或主题", { status: 400, code: "missing_prompt" });
      if (!/\[Verse\]/.test(lyrics) || !/\[Chorus\]/.test(lyrics)) {
        throw new HttpError("YuE2 歌词需要 [Verse] 和 [Chorus] 段落；请先让 AI 写词或按官方格式补齐", { status: 400, code: "invalid_lyrics" });
      }
    }
    const candidates = Math.min(2, Math.max(1, Math.trunc(Number(body.candidates ?? body.best_of ?? 1)) || 1));
    if (candidates > 1) {
      throw new HttpError("双候选 PER 选择尚未接入；本轮默认单候选（GPU 成本约 2 倍）", { status: 400, code: "best_of_unavailable", details: { candidates } });
    }
    const rawDuration = body.duration;
    const durationText = String(rawDuration ?? "").trim().toLowerCase();
    const durationAuto = rawDuration === undefined || rawDuration === null || durationText === "" || durationText === "auto" || Number(rawDuration) === 0 || !Number.isFinite(Number(rawDuration));
    const resolvedDuration = durationAuto ? (instrumental ? 200 : autoSongDuration(lyrics)) : Math.min(300, Math.max(10, Math.round(Number(rawDuration))));
    if (!durationAuto && !instrumental) {
      const lyricsIssue = lyricsDurationIssue(lyrics, resolvedDuration);
      if (lyricsIssue) {
        throw new HttpError(lyricsIssue.message, { status: 400, code: "invalid_lyrics_duration", details: lyricsIssue });
      }
    }
    const rawStyle = String(body.tags || body.style || body.input || body.prompt || "").trim();
    const genderRaw = String(body.gender ?? body.vocalGender ?? "").trim().toLowerCase();
    const genderMap = { male: "male", female: "female", 男: "male", 女: "female" };
    if (genderRaw && !genderMap[genderRaw]) {
      throw new HttpError("gender 只支持 male / female（男 / 女）", { status: 400, code: "invalid_gender" });
    }
    const gender = genderMap[genderRaw] || "";
    const style = buildSongStyle({
      tags: rawStyle,
      gender,
      bpm: body.bpm,
      language: body.language,
      keyscale: body.keyscale,
      instrumental,
    });
    const seedValue = Number(body.seed);
    if (audioJobActive) throw new HttpError("已有音频任务在跑，请稍后再试", { status: 409, code: "audio_busy" });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      // YuE2 走节点内动态 offload，不用显存余额硬拒。
      if (abort.signal.aborted) return;
      audioJobActive = "song";
      let result;
      try {
        result = await runYue2ComfySong({
          comfy,
          config,
          logger,
          style,
          lyrics,
          seed: Number.isFinite(seedValue) ? seedValue : undefined,
          cot: String(body.cot || "full"),
          duration: resolvedDuration,
          signal: abort.signal,
          requestId: req.id,
          checkpoint,
          instrumental,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        const messageText = String(error?.message || error || "");
        const nodeHint = /YuE2InstrumentalConvert|does not exist|node .*not|not found/i.test(messageText);
        const modelHint = /yue2|checkpoint|value not in list|missing/i.test(messageText);
        if (instrumental) {
          if (nodeHint) {
            throw new HttpError("纯音乐转换节点未加载：请重启 ComfyUI 让 YuE2 Instrumental Convert 节点生效（随应用安装）。", { status: 503, code: "audio_instrumental_node_missing", details: { engine: "comfyui" } });
          }
          if (modelHint) {
            throw audioModelMissing();
          }
          throw error;
        }
        if (modelHint) {
          throw audioModelMissing();
        }
        throw error;
      }
      return sendAudioResult(res, req, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally {
      audioJobActive = null;
      abort.cleanup();
    }
  });

  // 音频三种子功能共用 /v1/audio/speech，由 body.mode 区分：
  //   voice-design 朗读文案 + 音色描述
  //   voice-clone  朗读文案 + 参考音频（ASR 自动转写参考文本）
  //   music        音乐描述(caption) + 歌词 + 时长
  // 返回 OpenAI 兼容的 { data: [{ b64_json | url }] }，二进制作由前端自行落地。
  app.post("/v1/audio/speech", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const mode = String(body.mode || "voice-design").trim();
    if (!AUDIO_MODES.includes(mode)) {
      throw new HttpError(`音频模式只能是 ${AUDIO_MODES.join(" / ")}`, { status: 400, code: "invalid_audio_mode" });
    }
    const entry = requireModel(registry, setup, body.model, "audio");
    if (entry.audioMode && entry.audioMode !== mode) {
      throw new HttpError(`模型 ${entry.name} 只支持「${entry.audioMode}」，不能用于「${mode}」`, { status: 400, code: "audio_mode_mismatch" });
    }
    // OpenAI 风格请求把文本放在 input，音乐模式也可以用 caption/lyrics 显式指定。
    const input = String(body.input ?? body.prompt ?? "").trim();
    const params = parseParams(body.params);
    let prompt = input;
    if (mode === "music") {
      if (!prompt) throw new HttpError("音乐生成需要音乐描述 caption", { status: 400, code: "missing_prompt" });
      params.maxDuration = normalizeMaxDuration(params.maxDuration ?? body.max_duration);
      // 歌词允许为空（纯器乐），空串就是器乐。
      params.lyrics = String(body.lyrics ?? params.lyrics ?? "");
    } else if (!prompt) {
      throw new HttpError(mode === "voice-clone" ? "音色克隆需要朗读文案 text" : "音色设计需要朗读文案 text", { status: 400, code: "missing_prompt" });
    }
    if (mode === "voice-design") {
      const rawVoiceDescription = String(body.voice_description ?? body.voiceDescription ?? (entry.strictModelNames ? params.voiceDescription : undefined) ?? "").trim();
      if (entry.strictModelNames && !rawVoiceDescription) throw new HttpError("创作音色设计需要 voice_description 或 params.voiceDescription", { status: 400, code: "missing_parameter" });
      // 音色描述是音质的关键：缺失时 Qwen3-TTS 会自由发挥，性别/年龄容易跑偏。
      // 但不该让整次生成失败 —— 用一个明确的中性兜底并告警，与参考实现一致。
      if (!rawVoiceDescription) {
        logger.warn(`音色设计缺少 voice_description，已使用中性兜底描述 ${req.id}`);
        params.voiceDescription = AUDIO_NEUTRAL_VOICE;
        params.voiceDescriptionFallback = true;
      } else {
        params.voiceDescription = rawVoiceDescription;
      }
    }
    let uploadedAudios = [];
    if (mode === "voice-clone") {
      const audioFiles = orderedAudioRefFiles(req.files || []);
      if (!audioFiles.length) {
        throw new HttpError("音色克隆需要参考音频 audios（单个文件）", { status: 400, code: "missing_reference_audio" });
      }
      uploadedAudios = await uploadImages(comfy, audioFiles);
    }
    params.filenamePrefix = `audio/${mode.replace(/-/g, "_")}_${randomId("").slice(0, 8)}`;
    const context = buildContext({
      prompt,
      count: 1,
      uploadedAudios,
      params,
      lyrics: params.lyrics,
      voiceDescription: params.voiceDescription,
    });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runAudio({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
        logger,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`audio ${mode} ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const file = result.files[0];
    if (!file) throw new HttpError("音频工作流没有返回音频", { status: 502, code: "no_audio_output" });
    logger.info(`audio ${mode} ${entry.name} seed=${result.usedSeed ?? "-"} -> ${result.promptId} ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const ext = extFromMime(file.mimeType, file.filename, "flac");
    // 兜底产生的产物要能让前端提示用户「补音色描述」，否则用户不知道音色为何偏中性。
    const warnings = params.voiceDescriptionFallback ? ["voice_description_fallback"] : [];
    if (responseFormat === "url") {
      const saved = await tasks.saveOutput(randomId("aud_"), file.buffer, ext, file.assetName);
      res.json({ created: Math.floor(Date.now() / 1000), data: [{ url: absoluteTaskUrl(config, req, saved.url) }], mime_type: file.mimeType, prompt_id: result.promptId, warnings });
      return;
    }
    res.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: file.buffer.toString("base64") }], mime_type: file.mimeType, prompt_id: result.promptId, warnings });
  });

  app.post("/v1/images/scene3d", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const panoEntry = registry.resolve(SCENE3D_PANO_ID);
    const seamEntry = registry.resolve(SCENE3D_SEAM_ID);
    if (!panoEntry || !seamEntry) {
      throw new HttpError("3D 场景工作流未注册", { status: 500, code: "missing_scene3d_workflow" });
    }
    for (const entry of [panoEntry, seamEntry]) {
      const unavailable = workflowAvailabilityProblem(setup, entry);
      if (unavailable) throw new HttpError(unavailable.message, { status: 409, code: unavailable.code, details: unavailable.details });
    }
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("3D 场景缺少输入图片", { status: 400, code: "missing_image" });
    const inputFile = files[0];
    const python = resolveScene3dPython({ comfyDir: config.comfyDir || inferComfyRootFromFolderPaths(setup.folderPaths?.() || {}) });
    const script = scene3dScriptPath();
    if (!python || !fs.existsSync(script)) {
      throw new HttpError("3D 场景缺少图像处理环境（Pillow/numpy/cv2）。可复制给 AI Agent：设置 SCENE3D_PYTHON 指向 ComfyUI 的 python_embeded，或安装 Pillow/numpy/opencv-python 后重试。", {
        status: 500,
        code: "missing_scene3d_image_runtime",
      });
    }
    const maxAttempts = Math.max(1, Math.min(3, Number(body.attempts) || 3));
    let baseSeed = Number(body.seed);
    if (!Number.isFinite(baseSeed) || baseSeed <= 0) baseSeed = crypto.randomInt(1, 2147483647);
    baseSeed = Math.trunc(baseSeed) % 2147483647 || 1;
    const sceneText = String(body.prompt ?? body.scene ?? "").trim();
    const readOffset = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5;
    };
    const offsetX = readOffset(body.offsetX ?? body.offset_x);
    const offsetY = readOffset(body.offsetY ?? body.offset_y);
    const prompt = buildScene3dPrompt(sceneText);
    const task = tasks.create({
      model: "image-scene-3d",
      request: { prompt: sceneText, seed: baseSeed, attempts: maxAttempts, offsetX, offsetY },
    });
    tasks.enqueue(task, async (_task, onProgress, signal) => {
      const report = (progress, phase, promptId) => {
        onProgress(promptId ? { progress, phase, promptId } : { progress, phase });
      };
      let lastPromptId = null;
      try {
        let lastMetrics = null;
        let lastReasons = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (signal.aborted) throw Object.assign(new Error("任务已取消"), { code: "cancelled" });
          const seed = ((baseSeed + attempt - 1 - 1) % 2147483647) + 1;
          report(0.08, "扩全景");
          const placed = await placeSource({
            python,
            script,
            inputBuffer: inputFile.buffer,
            offsetX,
            offsetY,
            signal,
          });
          const uploadedPlaced = await uploadImages(comfy, [
            { buffer: placed.buffer, originalname: `scene3d_placed_${seed}.png`, mimetype: "image/png" },
          ]);
          const panoContext = buildContext({ prompt, count: 1, images: [inputFile], uploadedImages: uploadedPlaced, params: { seed } });
          const pano = await runWorkflow({
            entry: panoEntry,
            context: panoContext,
            comfy,
            timeoutMs: config.requestTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: task.id,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
          });
          lastPromptId = pano.promptId;
          report(0.4, "扩全景", pano.promptId);
          const panoFile = pano.files.find((file) => /^image\//i.test(file.mimeType)) || pano.files[0];
          if (!panoFile) throw new Error("H3 全景扩图没有返回图片");
          await comfy.freeMemory().catch(() => {});

          report(0.45, "修缝");
          const assets = await prepareSeamAssets({
            python,
            script,
            panoBuffer: panoFile.buffer,
            inputBuffer: inputFile.buffer,
            signal,
          });
          const uploadedSeam = await uploadImages(comfy, [
            { buffer: assets.stripBuffer, originalname: `scene3d_strip_${seed}.png`, mimetype: "image/png" },
            { buffer: assets.maskBuffer, originalname: `scene3d_mask_${seed}.png`, mimetype: "image/png" },
          ]);
          const seamContext = buildContext({ count: 1, uploadedImages: uploadedSeam, params: { seed } });
          const seam = await runWorkflow({
            entry: seamEntry,
            context: seamContext,
            comfy,
            timeoutMs: config.requestTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: task.id,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
          });
          report(0.7, "修缝", seam.promptId);
          const seamFile = seam.files.find((file) => /^image\//i.test(file.mimeType)) || seam.files[0];
          if (!seamFile) throw new Error("Qwen 接缝修复没有返回图片");
          await comfy.freeMemory().catch(() => {});

          report(0.78, "建场景");
          const stitched = await stitchPanorama({
            python,
            script,
            panoBuffer: panoFile.buffer,
            repairedBuffer: seamFile.buffer,
            maskBuffer: assets.maskBuffer,
            inputBuffer: inputFile.buffer,
            signal,
          });
          const gate = evaluateScene3dMetrics(stitched.metrics);
          lastMetrics = { ...stitched.metrics, person_single: gate.person };
          lastReasons = gate.reasons;
          logger.info(
            `scene3d attempt ${attempt}/${maxAttempts} seed=${seed} mae=${lastMetrics.edge_mae ?? "-"} luma=${lastMetrics.luma_delta ?? "-"} person=${gate.person} passed=${gate.passed} ${task.id}`,
          );
          if (gate.passed) {
            report(0.95, "建场景", seam.promptId);
            return { buffer: stitched.buffer, ext: "png", mimeType: "image/png", promptId: seam.promptId };
          }
          await comfy.freeMemory().catch(() => {});
        }
        const error = new Error(
          `3D 场景质量门未通过（${maxAttempts} 个种子）：${lastReasons.join("；")}。可复制给 AI Agent：重试 /v1/images/scene3d，换更清晰的主体图或缩短场景描述；若连续失败，检查 H3-Image 与 Qwen 2.1 的节点/权重是否齐全。`,
        );
        error.code = "scene3d_quality_rejected";
        error.details = { attempts: maxAttempts, base_seed: baseSeed, last_metrics: lastMetrics, reasons: lastReasons };
        throw error;
      } catch (error) {
        if (lastPromptId) {
          logger.info(`scene3d task ${task.id} failed after prompt ${lastPromptId}: ${error?.message || error}`);
        }
        throw error;
      } finally {
        await comfy.freeMemory().catch(() => {});
      }
    });
    res.status(202).json({ id: task.id, taskId: task.id, status: task.status, progress: task.progress });
  });


  app.post("/v1/images/generations", async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const baseEntry = requireModel(registry, setup, body.model, "image");
    const mode = String(body.mode || body.imageMode || "").trim();
    requireWorkflowMode(setup, baseEntry, mode);
    const entry = mode ? registry.resolveForMode(baseEntry, mode) : baseEntry;
    if (body.background && !entry.bindings?.background && !entry.backgroundPrompt) {
      throw new HttpError(`工作流 ${entry.name} 没有 background 绑定，不能保证透明背景。`, { status: 400, code: "unsupported_background" });
    }
    const context = buildContext({
      prompt: applyBackgroundPrompt(stripImageLabelPreamble(body.prompt), body.background, entry),
      negative: body.negative,
      size: body.size,
      count: body.n ?? body.count,
      quality: body.quality,
      background: body.background,
      mode,
      params: parseParams(body.params),
      presets: entry.presets,
    });
    if (entry.id.startsWith("image-moss-")) applyMossLayoutPrompt(context);
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runImage({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`image ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    logger.info(`image ${entry.name} seed=${result.usedSeed ?? "-"} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"), file.assetName);
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    if (!data.length) throw new HttpError("ComfyUI 没有返回图片", { status: 502, code: "no_images" });
    res.json({ created: Math.floor(Date.now() / 1000), data, seed: result.usedSeed ?? null });
  });

  app.post("/v1/images/upscale", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model || "image-esrgan-upscale", "image", { allowUnavailable: true });
    if (entry.category !== "upscale") {
      throw new HttpError(`模型 ${entry.name} 不是超分工作流`, { status: 400, code: "not_upscale_workflow" });
    }
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("超分请求缺少输入图片", { status: 400, code: "missing_input_image" });
    const uploadedImages = await uploadImages(comfy, [files[0]]);
    const context = buildContext({
      prompt: body.prompt,
      count: 1,
      images: [files[0]],
      uploadedImages,
      params: parseParams(body.params),
    });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runImage({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`upscale ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    logger.info(`upscale ${entry.name} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"), file.assetName);
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    if (!data.length) throw new HttpError("超分工作流没有返回图片", { status: 502, code: "no_images" });
    res.json({ created: Math.floor(Date.now() / 1000), data, seed: result.usedSeed ?? null });
  });

  app.post("/v1/3d/generations", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = registry.resolve("image-idol-3d");
    if (!entry) throw new HttpError("3D 工作流未注册", { status: 500, code: "missing_3d_workflow" });
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("3D 生成缺少输入图片", { status: 400, code: "missing_input_image" });
    const uploadedImages = await uploadImages(comfy, [files[0]]);
    const params = parseParams(body.params);
    params.idolMode = String(body.mode || params.idolMode || "synthetic").toLowerCase() === "real" ? "real" : "synthetic";
    const seed = Number(body.seed);
    if (Number.isFinite(seed) && seed > 0) params.seed = Math.trunc(seed);
    const gaussians = Number(body.num_gaussians ?? body.numGaussians);
    if (Number.isFinite(gaussians)) params.numGaussians = Math.max(32768, Math.min(1048576, Math.trunc(gaussians)));
    const context = buildContext({ images: [files[0]], uploadedImages, params, mode: params.idolMode });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`3d ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      const failureText = `${error?.message || ""} ${typeof error?.details === "string" ? error.details : JSON.stringify(error?.details || "")}`;
      if (/mask is empty|no object found/i.test(failureText)) {
        throw new HttpError("没有检测到可分离的主体：图片转3D 只适合单个物体；场景或三视图请先裁出一张主体图再试。", { status: 422, code: "no_3d_subject" });
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const video = result.files.find((file) => /\.(mp4|webm|mov)$/i.test(file.filename) || /^video\//i.test(file.mimeType));
    const model = result.files.find((file) => /\.(ply|spz|ksplat|splat)$/i.test(file.filename));
    const preview = result.files.find((file) => file !== video && file !== model && /^image\//i.test(file.mimeType));
    if (!model) throw new HttpError("3D 工作流没有返回模型文件", { status: 502, code: "no_3d_output", details: result.files.map((file) => file.filename) });
    const savedModel = await tasks.saveOutput(randomId("model3d_"), model.buffer, extFromMime(model.mimeType, model.filename, "ply"));
    const savedVideo = video ? await tasks.saveOutput(randomId("model3d_"), video.buffer, extFromMime(video.mimeType, video.filename, "mp4")) : null;
    const savedPreview = preview ? await tasks.saveOutput(randomId("model3d_"), preview.buffer, extFromMime(preview.mimeType, preview.filename, "png")) : null;
    logger.info(`3d ${entry.name} seed=${result.usedSeed ?? "-"} -> ${result.promptId} mode=${params.idolMode} ${req.id}`);
    res.json({
      created: Math.floor(Date.now() / 1000),
      prompt_id: result.promptId,
      seed: result.usedSeed ?? null,
      mode: params.idolMode,
      model: { url: absoluteTaskUrl(config, req, savedModel.url), bytes: savedModel.bytes, filename: model.filename },
      video: savedVideo ? { url: absoluteTaskUrl(config, req, savedVideo.url), bytes: savedVideo.bytes, filename: video.filename } : null,
      preview: savedPreview ? { url: absoluteTaskUrl(config, req, savedPreview.url), bytes: savedPreview.bytes, filename: preview.filename } : null,
    });
  });

  app.post("/v1/3d/scenes", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = registry.resolve("image-moge-scene");
    if (!entry) throw new HttpError("MoGe 场景工作流未注册", { status: 500, code: "missing_scene_workflow" });
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("场景建3D 缺少输入图片", { status: 400, code: "missing_input_image" });
    const uploadedImages = await uploadImages(comfy, [files[0]]);
    const params = parseParams(body.params);
    const resolution = Number(body.resolution ?? params.mogeResolution);
    if (Number.isFinite(resolution)) params.mogeResolution = Math.max(0, Math.min(9, Math.trunc(resolution)));
    const decimation = Number(body.decimation ?? params.mogeDecimation);
    if (Number.isFinite(decimation)) params.mogeDecimation = Math.max(1, Math.min(8, Math.trunc(decimation)));
    const context = buildContext({ images: [files[0]], uploadedImages, params });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`3d scene ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const model = result.files.find((file) => /\.(glb|gltf)$/i.test(file.filename));
    const preview =
      result.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.filename) && /render/i.test(file.filename)) ||
      result.files.find((file) => /^image\//i.test(file.mimeType));
    const depth = result.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.filename) && /depth/i.test(file.filename));
    if (!model) throw new HttpError("MoGe 没有返回网格文件", { status: 502, code: "no_scene_mesh", details: result.files.map((file) => file.filename) });
    const savedModel = await tasks.saveOutput(randomId("scene3d_"), model.buffer, extFromMime(model.mimeType, model.filename, "glb"));
    const savedPreview = preview ? await tasks.saveOutput(randomId("scene3d_"), preview.buffer, extFromMime(preview.mimeType, preview.filename, "png")) : null;
    const savedDepth = depth ? await tasks.saveOutput(randomId("scene3d_"), depth.buffer, extFromMime(depth.mimeType, depth.filename, "png")) : null;
    logger.info(`3d scene ${entry.name} -> ${result.promptId} res=${params.mogeResolution ?? 6} ${req.id}`);
    res.json({
      created: Math.floor(Date.now() / 1000),
      prompt_id: result.promptId,
      resolution: params.mogeResolution ?? 6,
      model: { url: absoluteTaskUrl(config, req, savedModel.url), bytes: savedModel.bytes, filename: model.filename, format: "glb" },
      preview: savedPreview ? { url: absoluteTaskUrl(config, req, savedPreview.url), bytes: savedPreview.bytes, filename: preview.filename } : null,
      depth: savedDepth ? { url: absoluteTaskUrl(config, req, savedDepth.url), bytes: savedDepth.bytes, filename: depth.filename } : null,
    });
  });

  app.post("/v1/images/edits", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model, "image");
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("图片编辑请求缺少参考图", { status: 400, code: "missing_input_image" });
    const mode = String(body.mode || "").trim() || (entry.variants ? Object.keys(entry.variants)[0] : "");
    if (entry.variants && !entry.variants[mode]) {
      throw new HttpError(`模型 ${entry.name} 不支持功能：${mode || "（空）"}`, { status: 400, code: "unsupported_image_mode" });
    }
    requireWorkflowMode(setup, entry, mode);
    if (entry.id === "image-qwen21") {
      if (mode === "inpaint" && files.length !== 2) {
        throw new HttpError("Qwen 局部重绘需要 2 张图：原图 + 二值蒙版", { status: 400, code: "invalid_inpaint_media" });
      }
      if (mode === "remove" && files.length !== 2) {
        throw new HttpError("Qwen 元素移除需要 2 张图：原图 + 二值蒙版", { status: 400, code: "invalid_inpaint_media" });
      }
      if (mode === "edit" && files.length > 3) {
        throw new HttpError("Qwen 多图编辑最多 3 张参考图", { status: 400, code: "too_many_reference_images" });
      }
      if (mode === "outpaint" && files.length !== 1) {
        throw new HttpError("Qwen 扩图需要且只接收 1 张原图", { status: 400, code: "invalid_outpaint_media" });
      }
    }
    const qwenEdit = entry.id === "image-qwen21" && mode === "edit" && files.length > 1;
    const orderedFiles = qwenEdit ? reorderQwenEditFiles(files) : files;
    const promptText = qwenEdit
      ? reorderQwenEditPrompt(body.prompt, files.length)
      : entry.id === "image-qwen21"
        ? body.prompt
        : stripImageLabelPreamble(body.prompt);
    const resolvedEntry = registry.resolveForMode(entry, mode);
    if (body.background && !resolvedEntry.bindings?.background && !resolvedEntry.backgroundPrompt) {
      throw new HttpError(`工作流 ${resolvedEntry.name} 没有 background 绑定，不能保证透明背景。`, { status: 400, code: "unsupported_background" });
    }
    const uploadedImages = await uploadImages(comfy, orderedFiles);
    // 同一张卡上重绘/扩图并发出多张只会互抢显存，统一收敛为单张；
    // 扩图采样像素按配置封顶，避免 16MP 在 16GB 卡上必 OOM。
    const editParams = parseParams(body.params);
    const singleShot = mode === "inpaint" || mode === "outpaint" || mode === "remove";
    if (mode === "outpaint" && Number.isFinite(Number(editParams.megapixels))) {
      editParams.megapixels = Math.max(0.1, Math.min(Number(editParams.megapixels), config.outpaintMaxMegapixels));
    }
    const context = buildContext({
      prompt: applyBackgroundPrompt(promptText, body.background, resolvedEntry),
      negative: body.negative,
      size: body.size,
      count: singleShot ? 1 : (body.n ?? body.count),
      quality: body.quality,
      background: body.background,
      mode,
      images: orderedFiles,
      uploadedImages,
      params: editParams,
      presets: entry.presets,
    });
    if (entry.id.startsWith("image-moss-")) applyMossLayoutPrompt(context);
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runImage({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`edit ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    logger.info(`edit ${entry.name} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"), file.assetName);
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/prompts/optimize", upload.any(), async (req, res) => {
    const body = req.body || {};
    // 写歌歌词：task=lyrics 时走歌词专用优化，其余分支逻辑保持不变。
    if (String(body.task || "").toLowerCase() === "lyrics") {
      const abort = abortOnDisconnect(req, res, registerActiveRequest);
      try {
        const result = await lyricsOptimizer.optimize({
          prompt: body.prompt,
          style: body.style,
          duration: body.duration ?? body.seconds,
          signal: abort.signal,
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        if (abort.signal.aborted) {
          logger.info(`lyrics optimize 请求被客户端中断 ${req.id}`);
          return;
        }
        throw error;
      } finally {
        abort.cleanup();
      }
      return;
    }
    const files = orderedPromptImages(req.files || []);
    const useCloud = String(body.engine || "").toLowerCase() === "cloud";
    const uploadedImages = !useCloud && files.length ? await uploadImages(comfy, files) : [];
    const cloudImages = useCloud ? files.map((file) => `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`) : [];
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.optimize({
        prompt: body.prompt,
        mode: body.mode,
        duration: body.duration ?? body.seconds,
        referenceNote: body.referenceNote ?? body.reference_note,
        language: body.language,
        uploadedImages,
        cloudImages,
        imageCount: files.length,
        signal: abort.signal,
        engine: body.engine,
        cloud: {
          baseUrl: body.cloudBaseUrl,
          apiKey: body.cloudApiKey,
          model: body.cloudModel,
          apiFormat: body.cloudApiFormat || "openai",
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`prompt optimize 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
  });

  app.post("/v1/prompts/optimize-image", upload.any(), async (req, res) => {
    const body = req.body || {};
    const files = orderedPromptImages(req.files || []);
    const useCloud = String(body.engine || "").toLowerCase() === "cloud";
    const uploadedImages = !useCloud && files.length ? await uploadImages(comfy, files) : [];
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.optimizeImage({
        prompt: body.prompt,
        mode: body.mode,
        language: body.language,
        uploadedImages,
        imageCount: Number(body.imageCount) || 0,
        engine: body.engine,
        cloud: {
          baseUrl: body.cloudBaseUrl,
          apiKey: body.cloudApiKey,
          model: body.cloudModel,
          apiFormat: body.cloudApiFormat || "openai",
        },
        signal: abort.signal,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`image prompt optimize 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
  });

  app.post("/v1/prompts/caption", upload.any(), async (req, res) => {
    const body = req.body || {};
    const files = orderedPromptImages(req.files || []);
    if (!files.length) throw new HttpError("反推提示词请求缺少图片", { status: 400, code: "missing_reference_image" });
    const useCloud = String(body.engine || "").toLowerCase() === "cloud";
    const uploadedImages = useCloud ? [] : await uploadImages(comfy, files.slice(0, 1));
    const cloudImages = useCloud ? files.slice(0, 1).map((file) => `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`) : [];
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.captionImage({
        uploadedImages,
        cloudImages,
        language: body.language,
        instruction: body.instruction,
        engine: body.engine,
        cloud: { baseUrl: body.cloudBaseUrl, apiKey: body.cloudApiKey, model: body.cloudModel, apiFormat: body.cloudApiFormat || "openai" },
        signal: abort.signal,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`image caption 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
  });

  app.post("/v1/videos/upscale", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model || "video-seedvr2-upscale", "video", { allowUnavailable: true });
    if (entry.category !== "upscale") {
      throw new HttpError(`模型 ${entry.name} 不是视频超分工作流`, { status: 400, code: "not_upscale_workflow" });
    }
    // 超分端点允许 allowUnavailable（权重下载是按需的），但节点缺失必须在这里拦住：
    // 否则 RelayVSR 这类依赖新版核心节点的工作流只会把 ComfyUI 的原始校验错误抛给用户。
    const missingClasses = missingNodeClasses(entry.workflow, setup.hasNodeClass?.bind(setup));
    if (missingClasses.length) {
      throw new HttpError(
        `模型 ${entry.name} 需要当前 ComfyUI 尚未提供的节点：${missingClasses.join("、")}。请升级 ComfyUI 后重启再试。`,
        { status: 409, code: "workflow_nodes_missing", details: { workflowId: entry.id, nodes: missingClasses } },
      );
    }
    const videoFiles = orderedVideoRefFiles(req.files || []);
    if (!videoFiles.length) throw new HttpError("视频超分请求缺少输入视频", { status: 400, code: "missing_input_video" });
    const uploadedVideos = await uploadImages(comfy, videoFiles);
    const params = parseParams(body.params);
    // SeedVR2 的「最高画质」默认值在 16GB 卡上必 OOM；按实际显存分档收敛。
    // RelayVSR 没有 batch/目标分辨率这两个可调项（倍率由权重决定），不能套用这套分档。
    const isRelayVsr = /relayvsr/i.test(String(entry.id || entry.name || ""));
    const vramGb = isRelayVsr ? 0 : gpuVramTotalGb(await readSystemStats({ cacheMs: 30000 }));
    const tier = vramGb > 0 && vramGb <= 18 ? { resolution: 1024, batch: 1 } : vramGb > 0 && vramGb <= 26 ? { resolution: 1280, batch: 2 } : null;
    if (tier) {
      const requestedResolution = Number(params.resolution) || 0;
      const requestedBatch = Number(params.batch_size) || 0;
      params.resolution = requestedResolution > 0 ? Math.min(requestedResolution, tier.resolution) : tier.resolution;
      params.batch_size = requestedBatch > 0 ? Math.min(requestedBatch, tier.batch) : tier.batch;
      if (requestedResolution > tier.resolution || requestedBatch > tier.batch) {
        logger.warn(`视频超分按 ${Math.round(vramGb)}GB 显存收敛为 ${params.resolution}/${params.batch_size}（请求 ${requestedResolution}/${requestedBatch}）`);
      }
    }
    const context = buildContext({
      count: 1,
      mode: "upscale",
      videos: videoFiles,
      uploadedVideos,
      params,
    });
    const task = tasks.create({
      model: entry.name,
      request: {
        mode: "upscale",
        video: uploadedVideos[0]?.name,
        resolution: params.resolution,
        fps: params.fps,
        scale: params.scale,
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const result = await runVideo({
        entry,
        context,
        comfy,
        timeoutMs: config.videoTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        readLocalOutput,
        onProgress: progress,
        logger,
      });
      const file = result.files[0];
      return {
        buffer: file.buffer,
        assetName: file.assetName,
        ext: extFromMime(file.mimeType, file.filename, "mp4"),
        mimeType: file.mimeType,
        promptId: result.promptId,
      };
    });
    logger.info(`video upscale ${entry.name} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.post("/v1/videos/interpolate", upload.any(), async (req, res) => {
    const body = req.body || {};
    const videoFiles = orderedVideoRefFiles(req.files || []);
    if (!videoFiles.length) throw new HttpError("插帧请求缺少输入视频", { status: 400, code: "missing_input_video" });
    const multiplier = String(body.multiplier || "2x").trim().toLowerCase();
    if (!["2x", "3x"].includes(multiplier)) {
      throw new HttpError("插帧只支持 2x 或 3x", { status: 400, code: "invalid_interpolation" });
    }
    const source = videoFiles[0];
    const probes = config.comfyDir
      ? [path.join(config.comfyDir, "ffprobe.exe"), path.join(config.comfyDir, "..", "ffprobe.exe"), path.join(config.comfyDir, "ffmpeg", "bin", "ffprobe.exe")]
      : [];
    const sourceInfo = probeVideoInfo(source, probes);
    const sourceFps = sourceInfo.fps > 0 ? sourceInfo.fps : 24;
    if (!sourceInfo.fps) logger.warn(`插帧未探测到源视频帧率，按 24fps 处理：${req.id}`);
    const task = tasks.create({
      model: "video-rife",
      request: { mode: "interpolate", multiplier, video: source.originalname || "input.mp4", source_fps: sourceFps },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      progress?.({ phase: "interpolating", progress: 0.1 });
      const interpolated = await videoInterpolator.interpolate({
        comfy,
        buffer: source.buffer,
        filename: source.originalname || "input.mp4",
        multiplier: multiplier === "3x" ? 3 : 2,
        sourceFps,
        requestId: req.id,
        signal,
        timeoutMs: config.interpolationTimeoutMs,
        onProgress: progress,
      });
      return {
        buffer: interpolated.buffer,
        ext: extFromMime(interpolated.mimeType, interpolated.filename, "mp4"),
        mimeType: interpolated.mimeType,
      };
    });
    logger.info(`video interpolate ${multiplier} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  // 视频编辑工作台的「导出成片」：按全局时间线导出最上层镜头与其音频。
  // 与 /v1/videos 的生成任务同构（返回 task id + 轮询 /v1/videos/:id），
  // 前端因此可以复用同一套轮询与落库逻辑，不必为合并单独写一条链路。
  app.post("/v1/videos/merge", videoMergeUpload.any(), async (req, res) => {
    const videoFiles = (req.files || []).filter((file) => file?.buffer && /^videos?(\[\])?$/i.test(file.fieldname || ""));
    if (!videoFiles.length) throw new HttpError("合并请求缺少视频片段", { status: 400, code: "missing_input_video" });
    // 片段顺序由 timeline 决定，不能依赖 multer 的到达顺序（并发上传会乱序）。
    const timeline = parseMergeTimeline(req.body?.timeline);
    const clips = timeline.map((item) => {
      const file = videoFiles[item.source];
      if (!file) throw new HttpError(`timeline 的 source=${item.source} 超出上传视频范围`, { status: 400, code: "invalid_timeline" });
      return {
        buffer: file.buffer,
        inPoint: item.inPoint,
        outPoint: item.outPoint,
        duration: item.duration,
        start: item.start,
        track: item.track,
        layer: item.layer,
        volume: item.volume,
      };
    });
    const size = parseSize(req.body?.size);
    const fps = Number(req.body?.fps) || 0;
    const task = tasks.create({
      model: "video-timeline-merge",
      request: {
        mode: "merge",
        clips: clips.length,
        total_seconds: Number(req.body?.total_seconds) || 0,
        size: size ? `${size.width}x${size.height}` : "",
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const merged = await videoMerger.merge({
        clips,
        size: size || undefined,
        fps,
        requestId: req.id,
        signal,
        onProgress: progress,
      });
      return {
        buffer: merged.buffer,
        ext: "mp4",
        mimeType: merged.mimeType,
      };
    });
    logger.info(`video merge ${clips.length} clips queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.post("/v1/videos", creationVideoUpload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model, "video");
    const easyMedia = h3EasyBinding(entry);
    const easyFiles = easyMedia ? h3EasyUploadFiles(req.files || []) : null;
    const files = easyFiles ? easyFiles.uploadedImages : orderedVideoFiles(req.files || []);
    const videoFiles = easyFiles ? easyFiles.uploadedVideos : orderedVideoRefFiles(req.files || []);
    const audioFiles = easyFiles ? easyFiles.uploadedAudios : orderedAudioRefFiles(req.files || []);
    const extraParams = parseParams(body.params);
    if (easyMedia) {
      h3EasyReferences({ ...easyFiles, params: extraParams }, easyMedia);
      const missing = missingNodeClasses({
        ...(files.length ? { image: { class_type: "LoadImage" } } : {}),
        ...(audioFiles.length ? { audio: { class_type: "LoadAudio" } } : {}),
        ...(videoFiles.length ? { video: { class_type: "LoadVideo" } } : {}),
      }, setup.hasNodeClass?.bind(setup));
      if (missing.length) throw new HttpError(`缺少 H3Easy 媒体节点：${missing.join("、")}`, { status: 409, code: "workflow_unavailable", details: { missingNodes: missing } });
    }
    const params = { ...extraParams };
    const interpolation = String(params.interpolation || "off").trim();
    if (!["off", "2x", "3x"].includes(interpolation)) {
      throw new HttpError("插帧只支持 off、2x、3x", { status: 400, code: "invalid_interpolation" });
    }
    if (params.segmentSeconds != null && params.segmentSeconds !== "") {
      const rawSeconds = Number(params.segmentSeconds);
      if (!Number.isFinite(rawSeconds) || rawSeconds < 3.75 || rawSeconds > 14.4) {
        throw new HttpError("分段长度必须在 3.75–14.4 秒之间", { status: 400, code: "invalid_segment_seconds" });
      }
    }
    const viggleSectionFrames = alignViggleFramesUp(Number(params.segmentFrames) || Number(params.segmentSeconds) * 24 || 277);
    // VDN and no-VDN variants share media contracts. Keep entry.id/name intact
    // for model selection and execution; normalize only for H3 validation.
    const h3WorkflowId = String(entry.id || "").replace(/-novdn$/, "");
    const requestedViggleMode = String(body.mode || "").trim();
    const viggleEditing = entry.id === "video-h3-viggle-swap" && /^(edit|edit-singularity)$/i.test(requestedViggleMode);
    let videoMode = String(body.mode || "").trim();
    if (h3WorkflowId === "video-h3-t2v") videoMode = "text";
    else if (h3WorkflowId === "video-h3-frames") videoMode = "frames";
    else if (h3WorkflowId === "video-h3-fast") videoMode = videoMode === "text" ? "text" : "frames";
    else if (h3WorkflowId === "video-h3-ref2va" || h3WorkflowId === "video-h3-character-swap") videoMode = "reference";
    else if (h3WorkflowId === "video-h3-viggle-swap") {
      // Viggle Remake：空 mode 走换人；编辑档在 pruned 底模缺失时自动回退 Singularity。
      if (!videoMode) videoMode = "swap";
      videoMode = resolveVariantFallback(setup, entry, videoMode);
    }
    if (entry.variants) requireWorkflowMode(setup, entry, videoMode);
    let requiredImageCount = Object.values(entry.bindings || {}).reduce((max, binding) => {
      if (!binding) return max;
      if (binding.from === "image" && binding.array) return Math.max(max, Number(binding.min ?? 0));
      if (binding.required && (binding.from === "image" || binding.imageIndex !== undefined)) {
        return Math.max(max, (Number.isInteger(binding.imageIndex) ? binding.imageIndex : 0) + 1);
      }
      return max;
    }, 0);
    if (h3WorkflowId === "video-h3-t2v") {
      if (files.length || videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 文生视频不接收图片/视频/音频；首尾帧请选 H3 首尾帧，多参请选 H3 多参", { status: 400, code: "unsupported_video_media" });
      }
      requiredImageCount = 0;
    } else if (h3WorkflowId === "video-h3-fast" && videoMode === "text") {
      if (files.length || videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 极速草稿的文生模式不接收图片/视频/音频；要首帧请切到首尾帧", { status: 400, code: "unsupported_video_media" });
      }
      requiredImageCount = 0;
    } else if (h3WorkflowId === "video-h3-frames" || h3WorkflowId === "video-h3-fast") {
      if (videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 首尾帧只接收 1–2 张图片；音频/视频请选 H3 多参", { status: 400, code: "unsupported_video_media" });
      }
      const frameMode = String(params.frameMode || (files.length >= 2 ? "both" : "first"));
      if (!["first", "last", "both"].includes(frameMode)) {
        throw new HttpError("frameMode 必须是 first、last 或 both", { status: 400, code: "invalid_frame_mode" });
      }
      params.frameMode = frameMode;
      requiredImageCount = frameMode === "both" ? 2 : 1;
    } else if (entry.id === "video-h3-viggle-swap") {
      // Viggle Remake：1 段源视频 + 1–4 张参考图；音轨直接沿用源视频。
      const allVideoRefs = (req.files || []).filter((file) => file?.buffer && /^videos?(\[\])?$/i.test(file.fieldname || ""));
      const viggleLabel = viggleEditing ? "视频编辑" : "Viggle 角色替换";
      if (allVideoRefs.length !== 1) {
        throw new HttpError(`${viggleLabel}需要且仅需要 1 段源视频`, { status: 400, code: "missing_source_video" });
      }
      if (!files.length || files.length > 4) {
        throw new HttpError(
          viggleEditing
            ? "视频编辑需要 1 张编辑参考图（最多 4 张）：从源视频抽一帧、用图像编辑改好后再上传（pins 填该帧号）"
            : "Viggle 角色替换需要 1–4 张角色参考图",
          { status: 400, code: "invalid_reference_images" },
        );
      }
      if (audioFiles.length) {
        throw new HttpError(`${viggleLabel}直接沿用源视频音轨，不需要单独上传音频`, { status: 400, code: "unsupported_audio" });
      }
      requiredImageCount = 0;
    }
    if (files.length < requiredImageCount) {
      const hint = h3WorkflowId === "video-h3-ref2va" ? "（H3 多参支持 1–6 图 / 0–2 音频 / 0–1 视频，至少一种媒体）" : (h3WorkflowId === "video-h3-frames" || h3WorkflowId === "video-h3-fast") ? "（首尾帧支持首帧、尾帧或首尾帧；首尾帧模式需要 2 张图）" : "";
      throw new HttpError(`工作流 ${entry.name} 需要至少 ${requiredImageCount} 张参考图${hint}`, { status: 400, code: "missing_reference_image" });
    }
    if (entry.minMedia && files.length + videoFiles.length + audioFiles.length < Number(entry.minMedia)) {
      throw new HttpError(`工作流 ${entry.name} 需要至少 ${entry.minMedia} 个参考素材（图片/音频/视频）`, { status: 400, code: "missing_reference_media" });
    }
    if (entry.id === "video-h3-viggle-swap" && videoFiles.length === 1) {
      // Remake 直接吃源视频音轨；没有音轨时补一条静音，并把画布按原比例缩到短边 480。
      const patched = await ensureSourceAudio(videoFiles[0], { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" });
      if (patched !== videoFiles[0]) {
        videoFiles[0] = patched;
        logger.info("Viggle 源视频没有音轨，已补静音音轨后上传");
      }
      const fitted = await fitViggleSourceCanvas(videoFiles[0], { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" });
      if (fitted !== videoFiles[0]) {
        videoFiles[0] = fitted;
        logger.info("Viggle 源视频已按原比例缩放为短边 480（避免 Remake 画布拉伸）");
      }
    }
    if (entry.id === "video-h3-viggle-swap") {
      // 透明参考图先压到源片背景色上，避免透明像素被模型画成黑底。
      const prepared = await flattenViggleReferences(files, videoFiles[0], { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" });
      for (let index = 0; index < files.length; index += 1) files[index] = prepared[index] || files[index];
    }
    const uploadedImages = await uploadImages(comfy, files);
    const uploadedVideos = await uploadImages(comfy, videoFiles);
    const uploadedAudios = await uploadImages(comfy, audioFiles);
    // H3 有硬性像素上限（1920x1088 = 2,088,960）。4K 卡片会算出 3840x2176
    // = 8,355,840（上限的 4 倍），以前要跑到 ComfyUI 才由 conditioning 节点抛
    // ValueError，白等一轮 GPU。这里在入口就拦住并给出可用尺寸。
    const requestedSize = parseSize(body.size);
    if (requestedSize && exceedsH3PixelLimit(requestedSize.width, requestedSize.height)) {
      throw new HttpError(h3PixelLimitMessage(requestedSize.width, requestedSize.height), {
        status: 400,
        code: "h3_canvas_too_large",
        details: { limit: 1920 * 1088, requested: { width: snap32(requestedSize.width), height: snap32(requestedSize.height) } },
      });
    }
    const context = buildContext({
      prompt: body.prompt,
      size: body.size,
      count: 1,
      quality: body.resolution_name || body.vquality,
      seconds: body.seconds,
      mode: videoMode,
      images: files,
      uploadedImages,
      uploadedVideos,
      uploadedAudios,
      params: {
        ...params,
        ratio: body.ratio,
        resolution_name: body.resolution_name,
        generate_audio: body.generate_audio,
        watermark: body.watermark,
      },
    });
    let sourceVideoTruncated = false;
    let sourceFps = 0;
    let autoPins = null;
    if (videoFiles.length && !easyMedia) {
      // H3 统一按 24fps 出片：源视频用时长×24 换算帧数，30/60fps 素材不会算长。
      const sourceSeconds = Number(body.source_duration_seconds);
      const fromDuration = framesFromSeconds(sourceSeconds);
      const probes = config.comfyDir
        ? [path.join(config.comfyDir, "ffprobe.exe"), path.join(config.comfyDir, "..", "ffprobe.exe"), path.join(config.comfyDir, "ffmpeg", "bin", "ffprobe.exe")]
        : [];
      const info = probeVideoInfo(videoFiles[0], probes);
      sourceFps = info.fps || 0;
      const probedFrames = info.duration > 0 ? Math.round(info.duration * 24) : 0;
      const sourceFrames = probedFrames || fromDuration;
      const viggle = entry.id === "video-h3-viggle-swap";
      if (viggle && info.fps > 0 && Math.abs(info.fps - 24) > 0.01) {
        logger.info(`源视频 ${info.fps.toFixed(2)}fps → 24fps（VHS force_rate=24 归一）`);
      }
      if (viggle && (!sourceFrames || sourceFrames < VIGGLE_MIN_FRAMES)) {
        throw new HttpError(`Viggle 角色替换的源视频至少需要 3.75 秒（90 帧 @24fps），当前约 ${(Math.max(0, sourceFrames) / 24).toFixed(2)} 秒`, {
          status: 400, code: "source_video_too_short", details: { sourceFrames, minimum: VIGGLE_MIN_FRAMES },
        });
      }
      const longVideoEnabled = params.longVideo !== false;
      const viggleLong = viggle && longVideoEnabled && sourceFrames > viggleSectionFrames;
      const aligned = viggle ? (viggleLong ? viggleSectionFrames : alignViggleFramesUp(sourceFrames)) : alignH3Frames(sourceFrames);
      // 官方 H3 参考视频单段上限 15 秒（24fps 下 362 帧 = 17×21+5）；
      // Viggle Remake 单窗口上限 345 帧（14.375 秒），更长时由长视频编排器逐段生成。
      const capped = viggle ? (viggleLong ? viggleSectionFrames : (longVideoEnabled ? aligned : Math.min(aligned, VIGGLE_MAX_FRAMES))) : capH3ReferenceFrames(aligned);
      context.sourceVideoFrames = capped;
      context.sourceTotalFrames = sourceFrames;
      // Remake 只能接 17n+5：源片不足时补帧到下一档，生成后再裁回源时长，避免对齐丢帧。
      if (viggle && !viggleLong && aligned > sourceFrames) {
        const padDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "viggle-pad-"));
        try {
          const paddedBuffer = await padSourceForSegment(
            videoFiles[0],
            sourceFrames,
            aligned,
            { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" },
            padDir,
          );
          videoFiles[0] = { ...videoFiles[0], buffer: paddedBuffer, size: paddedBuffer.length, originalname: "source-padded.mp4" };
          const [paddedUpload] = await uploadImages(comfy, [videoFiles[0]]);
          uploadedVideos[0] = paddedUpload;
          context.uploadedVideos[0] = paddedUpload;
          logger.info(`Viggle 源视频 ${sourceFrames} 帧补齐到 ${aligned} 帧后上传（frame_load_cap=${aligned}）`);
        } finally {
          await fs.promises.rm(padDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      context.viggleSegmentFrames = viggleSectionFrames;
      context.viggleLong = viggleLong;
      context.viggleLongEnabled = longVideoEnabled;
      sourceVideoTruncated = viggle ? (!viggleLong && sourceFrames > capped) : capped > 0 && aligned > capped;
      if (viggleLong) logger.info(`源视频 ${sourceFrames} 帧 > 分段 ${viggleSectionFrames} 帧，将逐段生成并 RemakePrefix 接力`);
      if (viggle && !longVideoEnabled && sourceFrames > capped) logger.info(`长视频分段已关闭：源视频 ${sourceFrames} 帧截断为 ${capped} 帧`);
      if (viggle) {
        // SageAttention 默认开（auto）；运行库/硬件不可用时静默回退并记日志。
        const sageRaw = String(params.sage ?? "auto").trim().toLowerCase();
        params.sage = ["disabled", "off", "false", "0"].includes(sageRaw) ? "disabled" : "auto";
        if (params.sage !== "disabled") {
          const sageAvailable = await probeSageAvailability(resources);
          if (sageAvailable === false) {
            params.sage = "disabled";
            logger.warn("SageAttention 运行库不可用，已静默回退为 disabled（本次生成不加速）");
          }
        }
        const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
        // 长视频尾段不足 90 帧会被丢弃；pins 上限按实际生成的最后一段末帧算，避免「校验通过但被静默丢弃」。
        const plannedEnd = viggleLong
          ? planViggleSegments(sourceFrames, viggleSectionFrames).reduce((end, segment) => Math.max(end, segment.start + segment.frames), 0)
          : 0;
        const pinLimit = viggleLong ? (plannedEnd || sourceFrames) : (sourceFrames ? Math.min(capped, sourceFrames) : capped);
        let pinsRaw = String(params.pins ?? "").trim();
        if (!pinsRaw && !viggleEditing) {
          // 一次产片：未显式给 pins 时自动选帧（laplacian+中心），每张角色图用同一个源帧。
          const K = Math.min(8, Math.max(1, pinLimit - 1));
          const indices = [];
          for (let i = 0; i < K; i += 1) {
            const value = K === 1 ? Math.max(1, Math.floor(pinLimit / 2)) : Math.round(1 + ((pinLimit - 2) * i) / (K - 1));
            if (value > 0 && value < pinLimit && !indices.includes(value)) indices.push(value);
          }
          const candidates = await extractVideoFrames(videoFiles[0], { frames: indices, config: ffmpegConfig });
          const scored = await scoreVideoFrames(candidates, { config: ffmpegConfig, references: files });
          const usable = scored.filter((item) => item.score > 0 && !item.black).sort((a, b) => b.score - a.score);
          if (!usable.length) {
            throw new HttpError("源视频没有可用的候选帧（全黑或无法打分）；请显式填写 pins 或更换源视频", { status: 422, code: "no_usable_frame" });
          }
          const best = usable[0].frame;
          pinsRaw = Array(files.length).fill(String(best)).join(", ");
          params.pins = pinsRaw;
          autoPins = { frame: best, source: "reference-similarity+heuristic", scores: scored.map((item) => ({ frame: item.frame, score: item.score, similarity: item.similarity, black: item.black })) };
          logger.info(`Viggle 自动 pins：frame=${best}（${files.length} 张角色图，启发式）`);
        }
        if (!pinsRaw) {
          throw new HttpError(
            viggleEditing
              ? "视频编辑需要填写 pins（源帧号）：每张编辑参考图一个，例如 96；pins 为空时不会注入关键帧，编辑不会生效"
              : "Viggle 角色替换需要填写 pins（源帧号）：每张角色参考图一个，例如 96；pins 为空时不会注入关键帧，人物不会被替换",
            { status: 400, code: "missing_pins", details: { referenceImages: files.length } },
          );
        }
        const pins = pinsRaw.split(/[,\s]+/).filter(Boolean).map(Number);
        if (pins.length !== files.length) {
          throw new HttpError(`pins 数量必须等于${viggleEditing ? "编辑参考图" : "角色参考图"}数量（当前 ${pins.length} 个 pins / ${files.length} 张参考图）`, {
            status: 400, code: "invalid_pins", details: { pins, referenceImages: files.length },
          });
        }
        if (!pins.every((pin) => Number.isInteger(pin) && pin > 0 && pin < pinLimit)) {
          throw new HttpError(`pins 必须是 1–${pinLimit - 1} 的整数，并且与参考图一一对应（0 会污染首帧，不允许）`, {
            status: 400, code: "invalid_pins", details: { pins, frames: pinLimit },
          });
        }
        params.pins = pins.join(", ");
        context.params = { ...(context.params || {}), pins: params.pins, sage: params.sage };
      }
      if (aligned && sourceFrames && aligned !== sourceFrames && !(viggle && !viggleLong && aligned > sourceFrames)) {
        logger.info(`源视频 ${sourceFrames} 帧，按 17n+5 对齐为 ${aligned} 帧（约 ${(aligned / 24).toFixed(1)}s）`);
      }
      if (sourceVideoTruncated) {
        const limit = viggle ? `Viggle 单窗口 ${(VIGGLE_MAX_FRAMES / 24).toFixed(2)}s` : "H3 单段 15s";
        logger.warn(`源视频约 ${(sourceFrames / 24).toFixed(1)}s，超过 ${limit} 上限，已截取前 ${(capped / 24).toFixed(1)}s`);
      }
      if (!probedFrames && fromDuration) logger.warn(`ffprobe 不可用，按上报时长 ${sourceSeconds}s 换算为 ${fromDuration} 帧`);
    }
    const task = tasks.create({
      model: entry.name,
      request: {
        prompt: String(body.prompt || ""),
        seconds: body.seconds,
        size: body.size,
        ratio: body.ratio,
        resolution_name: body.resolution_name,
        mode: videoMode,
        images: uploadedImages.map((image) => image.name),
        videos: uploadedVideos.map((file) => file.name),
        audios: uploadedAudios.map((file) => file.name),
        interpolation,
        source_video_truncated: sourceVideoTruncated,
        source_fps: sourceFps,
        segmented: context.viggleLong === true,
        segment_frames: context.viggleSegmentFrames || 0,
        ...(autoPins ? { meta: { mode: "viggle-one-shot", autoPins } } : {}),
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      // 长源视频走分段接力：每段单独 Remake，再用 RemakePrefix 串起来。
      const result = context.viggleLong
        ? await runViggleLongVideo({
            entry,
            context,
            comfy,
            sourceFile: videoFiles[0],
            segmentFrames: context.viggleSegmentFrames,
            config: { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "", comfyRoot: resources.comfyRoot?.() || "" },
            timeoutMs: config.videoTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: req.id,
            onProgress: progress,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
            readLocalOutput,
          })
        : await runVideo({
            entry,
            context,
            comfy,
            timeoutMs: config.videoTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: req.id,
            onProgress: progress,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
            readLocalOutput,
          });
      let file = result.files[0];
      if (interpolation !== "off") {
        progress?.({ phase: "interpolating", progress: 0.97 });
        const interpolated = await videoInterpolator.interpolate({
          comfy,
          buffer: file.buffer,
          filename: file.filename,
          multiplier: interpolation === "3x" ? 3 : 2,
          requestId: req.id,
          signal,
          timeoutMs: config.interpolationTimeoutMs,
          onProgress: progress,
        });
        file = { ...file, buffer: interpolated.buffer, filename: interpolated.filename, mimeType: interpolated.mimeType };
      }
      return {
        buffer: file.buffer,
        assetName: file.assetName,
        ext: extFromMime(file.mimeType, file.filename, "mp4"),
        mimeType: file.mimeType,
        promptId: result.promptId,
      };
    });
    logger.info(`video ${entry.name} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.get("/v1/videos/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const data = taskResponse(req, task);
    const preview = task.promptId ? previewHub.get(task.promptId) : null;
    const stepProgress = task.promptId ? previewHub.getProgress(task.promptId) : null;
    res.json({
      id: data.id,
      object: "video",
      status: data.status,
      progress: data.progress,
      prompt_id: data.promptId || undefined,
      steps: stepProgress ? { step: stepProgress.step, total: stepProgress.total } : undefined,
      preview: preview
        ? {
            url: `/api/previews/${encodeURIComponent(task.promptId)}?t=${preview.updatedAt}`,
            mime: preview.mime,
            step: preview.step,
            total: preview.total,
          }
        : undefined,
      url: data.url || undefined,
      error: data.error ? { message: data.error } : undefined,
      created_at: data.createdAt,
      completed_at: data.completedAt,
      model: data.model,
    });
  });

  // ---- 视频编辑预览（Phase2，§15 契约）：当前帧单图预览，后台按有无蒙版自动路由 ----
  const videoEditPreviewJobs = new Map();
  const videoEditPreviewTimeout = Math.min(Number(config.requestTimeoutMs) || 0, 5 * 60 * 1000) || 5 * 60 * 1000;

  function decodePreviewImage(value, field) {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value).trim();
    const match = /^data:([^;,]+)?(;base64)?,/i.exec(text);
    const base64 = match ? text.slice(match[0].length) : text;
    if (match && !match[2]) throw new HttpError(`${field} 必须是 base64 编码的图片`, { status: 400, code: `invalid_${field}` });
    let buffer;
    try { buffer = Buffer.from(base64, "base64"); } catch { buffer = Buffer.alloc(0); }
    if (!buffer.length) throw new HttpError(`${field} 不是有效的 base64 图片`, { status: 400, code: `invalid_${field}` });
    if (buffer.length > 32 * 1024 * 1024) throw new HttpError(`${field} 超过 32MB`, { status: 413, code: `too_large_${field}` });
    const mime = String(match?.[1] || "image/png").toLowerCase();
    return { buffer, mimetype: mime.startsWith("image/") ? mime : "image/png", originalname: `${field}.png` };
  }

  async function resolvePreviewSource(source) {
    const text = String(source || "").trim();
    if (!text) throw new HttpError("source 不能为空", { status: 400, code: "missing_source" });
    if (/^data:/i.test(text)) {
      const match = /^data:([^;,]+)?(;base64)?,/i.exec(text);
      if (!match?.[2]) throw new HttpError("source data URL 必须是 base64", { status: 400, code: "invalid_source" });
      const buffer = Buffer.from(text.slice(match[0].length), "base64");
      if (!buffer.length) throw new HttpError("source 为空", { status: 400, code: "invalid_source" });
      return { buffer, mimetype: match[1] || "video/mp4", originalname: "source.mp4" };
    }
    if (/^https?:/i.test(text)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("下载源视频超时")), 120000);
      try {
        const response = await fetch(text, { signal: controller.signal, redirect: "follow" });
        if (!response.ok) throw new HttpError(`源视频下载失败：HTTP ${response.status}`, { status: 422, code: "source_unavailable" });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new HttpError("源视频为空", { status: 422, code: "source_unavailable" });
        if (buffer.length > (Number(config.maxUploadBytes) || 512 * 1024 * 1024)) throw new HttpError("源视频超过上传上限", { status: 413, code: "source_too_large" });
        return { buffer, mimetype: response.headers.get("content-type") || "video/mp4", originalname: "source.mp4" };
      } finally {
        clearTimeout(timer);
      }
    }
    const base = safeFileName(path.basename(text.replace(/[?#].*$/, "")));
    const candidates = [];
    if (/^\/files\//i.test(text)) {
      const name = decodeURIComponent(text.replace(/^\/files\//i, "").replace(/[?#].*$/, ""));
      candidates.push(path.join(config.outputDir, safeFileName(name)));
    }
    candidates.push(path.join(config.outputDir, base));
    candidates.push(path.join(config.dataDir, "uploads", base));
    if (path.isAbsolute(text)) candidates.push(text);
    for (const file of candidates) {
      try {
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
          return { buffer: fs.readFileSync(file), mimetype: "video/mp4", originalname: path.basename(file) };
        }
      } catch { /* 继续下一个候选 */ }
    }
    throw new HttpError("source 无法解析为本地视频或 URL；可传 /files 地址、data URL 或绝对路径", { status: 422, code: "source_unavailable" });
  }

  function previewProbeDuration(file) {
    const candidates = [
      process.env.FFPROBE_PATH,
      "ffprobe",
      config.comfyDir && path.join(config.comfyDir, "ffprobe.exe"),
      config.comfyDir && path.join(config.comfyDir, "..", "ffprobe.exe"),
      config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg", "bin", "ffprobe.exe"),
    ].filter(Boolean);
    const binary = candidates.find((candidate) => {
      try { execFileSync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
    });
    if (!binary) throw new HttpError("网关未找到 ffprobe，无法按 frame_t 定位帧", { status: 422, code: "ffprobe_missing" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-edit-probe-"));
    try {
      const input = path.join(tempDir, "source.mp4");
      fs.writeFileSync(input, file.buffer);
      const raw = execFileSync(binary, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
      const duration = Number(String(raw).trim());
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("duration invalid");
      return duration;
    } catch (error) {
      throw new HttpError(`源视频时长探测失败：${String(error?.message || error).slice(0, 200)}`, { status: 422, code: "frame_extract_failed" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  function buildPreviewSwapGraph({ targetName, refName, prompt, strength, seed }) {
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_bf16.safetensors", weight_dtype: "default" } },
      "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors", strength_model: 1 } },
      "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: "oldx-qwen2.1人物替换.safetensors", strength_model: strength } },
      "4": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
      "5": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
      "6": { class_type: "LoadImage", inputs: { image: targetName } },
      "7": { class_type: "LoadImage", inputs: { image: refName } },
      "10": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["4", 0], vae: ["5", 0], negative_prompt: "extra fingers, missing fingers, deformed hands, bad anatomy, malformed hands", resolution: 1024, prompt, "images.image_1": ["7", 0], "images.image_2": ["6", 0] } },
      "11": { class_type: "VAEEncode", inputs: { pixels: ["6", 0], vae: ["5", 0] } },
      "12": { class_type: "CFGGuider", inputs: { model: ["3", 0], positive: ["10", 0], negative: ["10", 1], cfg: 1 } },
      "13": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
      "14": { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.35, 0.152292, 0" } },
      "15": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["15", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
      "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["5", 0] } },
      "18": { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: "video-edit-preview/swap" } },
    };
  }

  async function runPreviewSwap({ targetFile, refFile, prompt, strength }) {
    const [targetUpload, refUpload] = await uploadImages(comfy, [targetFile, refFile]);
    const seed = Math.floor(Math.random() * 2 ** 31);
    const graph = buildPreviewSwapGraph({ targetName: targetUpload.name, refName: refUpload.name, prompt, strength, seed });
    const submitted = await comfy.submit(graph, { clientId: randomId("video-edit-preview-") });
    const deadline = Date.now() + videoEditPreviewTimeout;
    while (Date.now() < deadline) {
      await sleep(config.pollIntervalMs);
      const hist = await comfy.history(submitted.promptId).catch(() => null);
      if (!hist) continue;
      if (hist.status?.status_str === "error") {
        const reason = (hist.status?.messages || []).flat().join(" ").slice(0, 300);
        throw new HttpError(`OLDX 替换执行失败：${reason || "未知错误"}`, { status: 502, code: "swap_failed" });
      }
      const out = hist.outputs?.["18"]?.images?.[0];
      if (out) {
        const viewed = await comfy.view(out);
        return { buffer: viewed.buffer, promptId: submitted.promptId };
      }
    }
    throw new HttpError("OLDX 替换超时", { status: 504, code: "swap_timeout" });
  }

  async function runPreviewQwen({ jobId, mode, prompt, frameFile, maskFile, requestId }) {
    const entry = requireModel(registry, setup, "image-qwen21", "image");
    requireWorkflowMode(setup, entry, mode);
    const files = maskFile ? [frameFile, maskFile] : [frameFile];
    const uploadedImages = await uploadImages(comfy, files);
    const context = buildContext({ prompt, mode, count: 1, images: files, uploadedImages, params: {} });
    const result = await runImage({ entry, context, comfy, timeoutMs: config.requestTimeoutMs, pollIntervalMs: config.pollIntervalMs, requestId, logger, loraCatalog: setup.loraNames() });
    const file = result.files[0];
    if (!file?.buffer?.length) throw new HttpError("预览工作流没有返回图片", { status: 502, code: "no_preview_output" });
    return { buffer: file.buffer, promptId: result.promptId };
  }

  function saveVideoEditPreview(jobId, buffer) {
    const filename = `video-edit-${jobId}.png`;
    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(path.join(config.outputDir, filename), buffer);
    return filename;
  }

  app.post("/v1/video-edit/preview", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const mode = String(body.mode || "").trim();
    if (!["swap", "edit"].includes(mode)) {
      throw new HttpError('mode 必须是 "swap" 或 "edit"', { status: 400, code: "invalid_mode" });
    }
    const frameT = Number(body.frame_t ?? body.frameT);
    const frameFileInput = decodePreviewImage(body.frame, "frame");
    const prompt = String(body.prompt ?? "").trim();
    const maskFile = decodePreviewImage(body.mask, "mask");
    const refFile = decodePreviewImage(body.ref, "ref");
    const strengthRaw = Number(body.strength);
    const strength = Math.max(0, Math.min(1, Number.isFinite(strengthRaw) ? strengthRaw : 0.9));
    if (mode === "swap" && !maskFile && !refFile) {
      throw new HttpError("swap 预览需要 ref 角色参考图", { status: 400, code: "missing_ref" });
    }
    if (!frameFileInput && (!Number.isFinite(frameT) || frameT < 0 || frameT > 1)) {
      throw new HttpError("未提供 frame 时，frame_t 必须是 0–1 之间的数字", { status: 400, code: "invalid_frame_t" });
    }
    const jobId = randomId("preview-");
    const job = { id: jobId, status: "running", imageUrl: null, error: null, route: "", promptId: null, createdAt: nowIso() };
    videoEditPreviewJobs.set(jobId, job);
    if (videoEditPreviewJobs.size > 200) {
      const oldest = videoEditPreviewJobs.keys().next().value;
      if (oldest) videoEditPreviewJobs.delete(oldest);
    }
    try {
      let frameFile;
      if (frameFileInput) {
        frameFile = { ...frameFileInput, originalname: "video-edit-frame.png" };
      } else {
        const sourceFile = await resolvePreviewSource(body.source);
        const duration = previewProbeDuration(sourceFile);
        const frameIndex = Math.max(0, Math.round(frameT * duration * 24));
        const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
        const frame = await extractVideoFrame(sourceFile, { frame: frameIndex, config: ffmpegConfig });
        frameFile = { buffer: frame.buffer, mimetype: "image/png", originalname: "video-edit-frame.png" };
      }
      let result;
      if (maskFile) {
        job.route = "qwen-inpaint";
        result = await runPreviewQwen({ jobId, mode: "inpaint", prompt, frameFile, maskFile, requestId: req.id });
      } else if (mode === "edit") {
        job.route = "qwen-edit";
        result = await runPreviewQwen({ jobId, mode: "edit", prompt, frameFile, maskFile: null, requestId: req.id });
      } else {
        job.route = "oldx-swap";
        const swapPrompt = prompt || "将目标人物替换为参考图中的人物；保持姿势、构图、背景与光照不变，只替换目标人物。";
        const finalPrompt = /^<rwth>/i.test(swapPrompt) ? swapPrompt : `<rwth>, ${swapPrompt}`;
        result = await runPreviewSwap({ targetFile: frameFile, refFile, prompt: finalPrompt, strength });
      }
      job.promptId = result.promptId || null;
      const filename = saveVideoEditPreview(jobId, result.buffer);
      job.imageUrl = absoluteTaskUrl(config, req, `/files/${encodeURIComponent(filename)}`);
      job.status = "completed";
      res.json({ job_id: jobId, image_url: job.imageUrl, status: job.status, route: job.route, prompt_id: job.promptId });
    } catch (error) {
      job.status = "failed";
      job.error = String(error?.message || error);
      throw error;
    }
  });

  app.get("/v1/video-edit/preview/:job_id", (req, res) => {
    const job = videoEditPreviewJobs.get(String(req.params.job_id || ""));
    if (!job) throw new HttpError("预览任务不存在", { status: 404, code: "preview_not_found" });
    res.json({ job_id: job.id, status: job.status, image_url: job.imageUrl, route: job.route, prompt_id: job.promptId, error: job.error });
  });


  app.get("/api/previews/:promptId", (req, res) => {
    const preview = previewHub.get(req.params.promptId);
    if (!preview) throw new HttpError("预览还没有生成", { status: 404, code: "preview_not_ready" });
    res.setHeader("Cache-Control", "no-store");
    if (preview.step != null) res.setHeader("X-Preview-Step", String(preview.step));
    if (preview.total != null) res.setHeader("X-Preview-Total", String(preview.total));
    res.type(preview.mime).send(Buffer.from(preview.data, "base64"));
  });

  app.get("/api/progress/:requestId", (req, res) => {
    const progress = previewHub.getByRequest(req.params.requestId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: progress?.state || "pending",
      step: progress?.step || 0,
      total: progress?.total || 0,
      prompt_id: progress?.promptId || undefined,
    });
  });

  app.get("/v1/videos/:id/content", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const file = tasks.contentPath(req.params.id);
    if (!file) throw new HttpError("视频文件还没有生成完成", { status: 409, code: "video_not_ready" });
    res.sendFile(path.basename(file), { root: path.dirname(file), dotfiles: "deny" });
  });

  // 「已经生成、但文件没取回来」的恢复入口。
  // 这类任务不该重跑：ComfyUI 那边可能是几十秒甚至几十分钟的采样，重来一次白烧算力。
  // 这里只按记录的 promptId 查 history、再从本地输出目录把它取回来。
  app.post("/v1/videos/:id/recover", async (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    if (task.status === "completed") {
      res.json({ ...taskResponse(req, task), recovered: false });
      return;
    }
    if (task.status === "running" || task.status === "queued" || task.status === "cancelling") {
      throw new HttpError("任务还在执行中，无需恢复", { status: 409, code: "video_still_running" });
    }
    // 只有「生成成功但取回失败」的任务才能这样救：它的 promptId 指向真实产物。
    if (task.error !== "output_download_failed" && !(task.error && /取回文件失败|output_download_failed/.test(String(task.error)))) {
      throw new HttpError("这个任务不是「文件未取回」导致的失败，请重新生成", { status: 409, code: "video_not_recoverable" });
    }
    if (!readLocalOutput) {
      throw new HttpError("没有配置 ComfyUI 目录，无法从本地取回文件；请重新生成", { status: 409, code: "local_output_unavailable" });
    }
    const promptId = task.promptId || task.partialOutput?.promptId;
    if (!promptId) throw new HttpError("任务缺少 promptId，无法恢复", { status: 409, code: "video_recover_no_prompt" });
    let recovered = null;
    try {
      const history = await comfy.history(promptId);
      const files = collectOutputFiles(history, {});
      for (const file of files) {
        const local = await readLocalOutput(file);
        if (!local) continue;
        recovered = { file, buffer: local.buffer, mimeType: local.contentType };
        break;
      }
    } catch (error) {
      throw new HttpError(`读取 ComfyUI 输出失败：${error?.message || error}`, { status: 502, code: "video_recover_failed" });
    }
    if (!recovered) {
      throw new HttpError("在 ComfyUI 输出目录里没有找到这个任务的产物", { status: 404, code: "video_recover_file_missing" });
    }
    const saved = await tasks.saveOutput(task.id, recovered.buffer, extFromMime(recovered.mimeType, recovered.file.filename, "mp4"));
    task.status = "completed";
    task.progress = 1;
    task.url = saved.url;
    task.file = saved.file;
    task.mimeType = recovered.mimeType;
    task.bytes = recovered.buffer.length;
    task.error = null;
    task.completedAt = nowIso();
    task.partialOutput = null;
    await tasks.persistNow();
    logger.info(`视频任务 ${task.id} 已从本地输出恢复（${recovered.file.filename}）${req.id}`);
    res.json({ ...taskResponse(req, task), recovered: true });
  });

  app.post("/v1/videos/:id/cancel", async (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const result = await tasks.cancel(req.params.id, comfy);
    res.json({ ...result, url: result.url ? absoluteTaskUrl(config, req, result.url) : null });
  });

  // ---- 角色替换长链（swap-chain）----
  app.post("/v1/swap-chain", upload.any(), async (req, res) => {
    const files = req.files || [];
    const source = files.find((file) => file.fieldname === "source_video" || String(file.mimetype || "").startsWith("video/"));
    const refs = files.filter((file) => file !== source && String(file.mimetype || "").startsWith("image/")).slice(0, 2);
    if (!source) throw new HttpError("缺少源视频", { status: 400, code: "missing_source_video" });
    // 提交前查模型，别等 ComfyUI 回「节点 2/3: Value not in list」——
    // 那种报错既没说缺哪个文件，也白占一次队列。
    // ComfyUI 的 loader 选项里常带子目录（如 "Qwen-功能2.1\\xxx.safetensors"），
    // 统一取 basename 后小写比较，避免因为路径写法差异误判缺失。
    const normalizeName = (value) => String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
    const catalog = typeof setup.loaderOptions === "function" ? setup.loaderOptions() || {} : {};
    const optionsFor = (classType, input) => {
      const keyed = catalog[`${classType}\u0000${input}`];
      const list = Array.isArray(keyed) ? keyed : catalog[classType];
      return new Set((Array.isArray(list) ? list : []).map(normalizeName));
    };
    // 按 swap-chain.js 里实际用的 loader 逐个查，粒度比「一个大集合」准。
    const loraOptions = optionsFor("LoraLoaderModelOnly", "lora_name");
    const unetOptions = optionsFor("UNETLoader", "unet_name");
    const clipOptions = optionsFor("CLIPLoader", "clip_name");
    const vaeOptions = optionsFor("VAELoader", "vae_name");
    // 清单没就绪时（网关刚启动 / ComfyUI 离线）不能断言「缺模型」——
    // 那种情况下 loaderOptions() 是空的，会把 9 个全判成缺失，严重误导。
    if (!isModelCatalogReady(catalog)) {
      throw new HttpError(
        "暂时读不到本地模型清单（ComfyUI 未连接或仍在扫描），请稍后重试；" +
          "如果一直如此，请检查 ComfyUI 是否在运行。",
        { status: 503, code: "model_catalog_unavailable" },
      );
    }
    const { missing } = findMissingSwapChainModels({
      hasLora: (file) => loraOptions.has(normalizeName(file)),
      hasModel: (file) => unetOptions.has(normalizeName(file)) || clipOptions.has(normalizeName(file)) || vaeOptions.has(normalizeName(file)),
    });
    if (missing.length) {
      throw new HttpError(missingSwapChainMessage(missing), {
        status: 409,
        code: "swap_chain_missing_models",
        details: { missing: missing.map((item) => ({ label: item.label, file: item.file })) },
      });
    }
    const job = await swapChain.create({
      source,
      refs,
      intent: req.body?.intent,
      mode: req.body?.mode,
      targetSelection: req.body?.target_selection,
      seed: req.body?.seed,
      // 换人时是否保留原片服装（true=只换脸，服装沿用原片）
      keepClothes: req.body?.keep_clothes === "true" || req.body?.keep_clothes === true,
    });
    res.status(202).json(job);
  });

  app.get("/v1/swap-chain/:id", (req, res) => {
    const job = swapChain.get(req.params.id);
    if (!job) throw new HttpError("任务不存在", { status: 404, code: "job_not_found" });
    res.json(job);
  });

  app.get("/v1/swap-chain/:id/content/:artifact", (req, res) => {
    const file = swapChain.artifactPath(req.params.id, req.params.artifact);
    if (!file || !fs.existsSync(file)) throw new HttpError("产物尚未生成", { status: 404, code: "artifact_not_found" });
    res.sendFile(file);
  });

  app.post("/v1/swap-chain/:id/cancel", async (req, res) => {
    res.json(await swapChain.cancel(req.params.id));
  });

  app.post("/v1/swap-chain/:id/resume", async (req, res) => {
    res.json(await swapChain.resume(req.params.id));
  });
  app.get("/v1/tasks/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("任务不存在", { status: 404, code: "task_not_found" });
    res.json(taskResponse(req, task));
  });

  app.get("/files/:name", (req, res) => {
    const filename = String(req.params.name || "");
    if (!filename || filename.length > 240 || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filename) || filename.startsWith(".") || /[. ]$/.test(filename)) throw new HttpError("文件名称无效", { status: 400, code: "invalid_filename" });
    const file = path.join(config.outputDir, filename);
    if (!filename || !fs.existsSync(file)) throw new HttpError("文件不存在", { status: 404, code: "file_not_found" });
    res.sendFile(filename, { root: config.outputDir, dotfiles: "deny" });
  });

  app.use((req, res) => {
    res.status(404).json(jsonError(`Not found: ${req.method} ${req.path}`, { status: 404, code: "not_found" }));
  });

  app.use((error, req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      const limitMb = Math.round(Number(config.maxUploadBytes || 0) / (1024 * 1024));
      error.message = `上传文件过大：单个文件上限 ${limitMb} MB。请压缩或剪短视频后重试（有需要可在 launcher/config.json 调整 maxUploadBytes）。`;
    }
    const status = Number(error?.status) || (error instanceof multer.MulterError ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400) : 500);
    let code = error?.code || (status >= 500 ? "internal_error" : "bad_request");
    if (error?.type === "entity.parse.failed") code = "invalid_json";
    if (status >= 500 && /out of memory|CUDA OOM|\bOOM\b|allocation on device/i.test(String(error?.message || ""))) {
      lastOOM = { at: nowIso(), message: String(error.message) };
    }
    logger.error(`${req.method} ${req.path} -> ${status} ${error?.message || error} ${req.id}`);
    if (res.headersSent) return;
    res.status(status).json(
      jsonError(error?.message || "Internal error", {
        status,
        code,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        details: error?.details,
      }),
    );
  });

  return { app, config, logger, registry, tasks, sessions, setup, comfy, skinUnlocks, abortActiveRequests, assistant };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { app, config, logger, tasks, setup, comfy, abortActiveRequests, assistant } = await createGatewayApp();
  let cleanupTimer = null;
  let stopping = false;
  const cleanup = () =>
    tasks.cleanup({ retentionDays: config.taskRetentionDays, maxTasks: config.maxStoredTasks }).catch((error) => logger.warn(`清理任务失败：${error.message}`));
  const server = app.listen(config.port, config.host, () => {
    logger.info(`ComfyUI gateway ${config.version} listening on http://${config.host}:${config.port}`);
    logger.info(`ComfyUI: ${config.comfyUrl} | workflows: ${config.workflowDir}`);
    if (config.scanOnStart) setup.start();
    if (config.taskRetentionDays > 0 || config.maxStoredTasks > 0) {
      void cleanup();
      cleanupTimer = setInterval(cleanup, config.cleanupIntervalMs);
      if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
    }
  });
  const shutdown = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down");
    if (cleanupTimer) clearInterval(cleanupTimer);
    await stopGateway({ tasks, comfy, setup, server, abortActiveRequests, assistant, logger });
    process.exit(exitCode);
  };
  app.locals.requestShutdown = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

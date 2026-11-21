import path from "node:path";

import { creationOutputParams } from "./creation-output-names.js";
import { applyBindings } from "./bindings.js";
import { applyLoraChain } from "./lora-chain.js";
import { applyKrea2Mode } from "./krea2-mode.js";
import { applyQwenHybridMode } from "./qwen-t2i-mode.js";
import { applyZImageAccel } from "./zimage-accel.js";
import { resolveMossTier } from "./moss-tier.js";
import { MODEL_LOADER_SPECS } from "./model-loaders.js";
import { workflowModelCompatibilityProblems } from "./workflow-model-compatibility.js";
import { mimeFromFilename, sleep, truncate } from "./util.js";

export class GenerationError extends Error {
  constructor(message, { status = 500, code = "generation_failed", details } = {}) {
    super(message);
    this.name = "GenerationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function resolveForMode(entry, mode) {
  const variant = mode ? entry?.variants?.[mode] : null;
  if (!variant) return entry;
  return {
    ...entry,
    ...variant,
    workflow: variant.workflow || entry.workflow,
    bindings: variant.bindings || entry.bindings,
    defaults: variant.defaults || entry.defaults,
  };
}

export function applyModelAliases(workflow, aliasFor, specs = MODEL_LOADER_SPECS, { strictModelNames = false } = {}) {
  if (typeof aliasFor !== "function") return workflow;
  let next = workflow;
  for (const spec of specs) {
    for (const [nodeId, node] of Object.entries(next || {})) {
      if (node?.class_type !== spec.classType) continue;
      const value = node.inputs?.[spec.input];
      if (typeof value !== "string") continue;
      const target = strictModelNames
        ? aliasFor(spec.classType, spec.input, value, null, { strictModelNames: true })
        : aliasFor(spec.classType, spec.input, value);
      if (strictModelNames && target && String(target).replace(/\\/g, "/").split("/").pop() !== value.replace(/\\/g, "/").split("/").pop()) {
        throw new GenerationError(`工作流不允许替换模型 ${value} → ${target}`, { status: 409, code: "strict_model_mismatch" });
      }
      if (!target || target === value) continue;
      if (next === workflow) next = { ...workflow };
      next[nodeId] = { ...node, inputs: { ...node.inputs, [spec.input]: target } };
    }
  }
  return next;
}

function applyMainModelFile(workflow, file) {
  if (!file) return workflow;
  const nodeId = Object.keys(workflow || {}).find((id) => {
    const node = workflow[id];
    return node?.class_type === "UNETLoader" && typeof node.inputs?.unet_name === "string";
  });
  if (!nodeId || workflow[nodeId].inputs.unet_name === file) return workflow;
  return { ...workflow, [nodeId]: { ...workflow[nodeId], inputs: { ...workflow[nodeId].inputs, unet_name: file } } };
}

function historyCompleted(history) {
  if (!history) return false;
  if (history.status?.completed === true) return true;
  if (history.status?.status_str === "success") return true;
  return Boolean(history.outputs && Object.keys(history.outputs).length);
}

function historyError(history) {
  if (!history) return "";
  if (history.status?.status_str === "error") {
    const events = Array.isArray(history.status.messages) ? history.status.messages : [];
    const executionError = events.findLast(item => Array.isArray(item) && item[0] === "execution_error" && item[1] && typeof item[1] === "object")?.[1];
    if (executionError) {
      const frames = Array.isArray(executionError.traceback) ? executionError.traceback.slice(-3).join("\n") : "";
      return [`节点 ${executionError.node_id || "?"} (${executionError.node_type || "?"})`, `${executionError.exception_type || "Error"}: ${executionError.exception_message || executionError.message || "执行失败"}`, frames, executionError.prompt_id ? `prompt_id=${executionError.prompt_id}` : ""].filter(Boolean).join("；");
    }
    const messages = events.flat();
    const text = messages
      .map((item) => (typeof item === "string" ? item : item?.message || JSON.stringify(item)))
      .filter(Boolean)
      .join("；");
    return text || "ComfyUI 执行失败";
  }
  return "";
}

const OUT_OF_MEMORY_PATTERN = /out\s*of\s*memory|outofmemoryerror|cuda error: out of memory|not enough memory|allocation on device/i;

function failureHint(failure) {
  const hints = [];
  if (/sageattention is not new enough|cannot apply MiniMax H3 Memory Efficient Sage Attention Patch/i.test(failure)) {
    hints.push("H3 需要 SageAttention 运行库：请在「设置 → 添加工作流 → H3 视频生成」安装「SageAttention 运行库（H3 必需）」，安装后重启 ComfyUI 再重试。");
  }
  if (/not in list|value_not_in_list|value not in list/i.test(failure)) {
    hints.push("工作流引用的模型文件在本机不存在：请在资源中心补齐，或在资源卡里替换为本机已有模型。");
  }
  if (/['"]default['"]\s*\(Stage-B\)\s*adapter\s*is\s*missing|Stage-B.*adapter.*missing|default.*adapter.*missing/i.test(failure)) {
    hints.push("VDN 模型不完整：stage-dmd-step-250 缺少 default (Stage-B) 适配器。请在资源中心重新下载完整的 stage-dmd-step-250 目录（保留 adapters/default 内部结构），重启 ComfyUI 后重试。");
  }
  if (/node ['\"]?[^'\"]+['\"]? not found|class_type[^\n]*not found|cannot execute because node/i.test(failure)) {
    hints.push("缺少节点插件：请在资源中心安装对应工作流依赖，重启 ComfyUI 后重试。");
  }
  if (/too many values to unpack \(expected 4\)/i.test(failure) && /qwen_image21[\\/]+model\.py/i.test(failure.replace(/\\\\/g, "/"))) {
    hints.push("Qwen Image 2.1 收到了非四维 latent。请检查是否把 2.1 主模型装进 Qwen 2511 的 VAE/编码工作流；需匹配整套主模型、VAE、编码器和 LoRA，不是提示词或参考图数量问题。");
  }
  return hints.length ? `。${hints.join(" ")}` : "";
}

function isOutOfMemoryError(error) {
  const details = typeof error?.details === "string" ? error.details : JSON.stringify(error?.details || "");
  return OUT_OF_MEMORY_PATTERN.test(`${error?.message || ""} ${details}`);
}

export function collectOutputFiles(history, { includePreview = false } = {}) {
  const files = [];
  const seen = new Set();
  // ComfyUI 的 SaveAudio / SaveAudioAdvanced 把结果放在 outputs[node].audio 里
  // （SavedAudios.as_dict() => {"audio": [...]}），文件名带 flac/mp3/opus 扩展名。
  for (const [nodeId, output] of Object.entries(history?.outputs || {})) {
    for (const key of ["images", "gifs", "videos", "3d", "audio"]) {
      for (const item of output?.[key] || []) {
        if (!item?.filename) continue;
        if (item.type && item.type !== "output" && !(includePreview && item.type === "temp")) continue;
        const dedupe = `${item.type || "output"}:${item.subfolder || ""}:${item.filename}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        files.push({ ...item, nodeId });
      }
    }
  }
  return files;
}

export async function runWorkflow({ entry, context, comfy, timeoutMs = 10 * 60 * 1000, pollIntervalMs = 750, signal, requestId, onProgress, logger, loraCatalog, modelAliasFor = null, loaderSpecs = MODEL_LOADER_SPECS, includePreviewOutputs = false, readLocalOutput = null }) {
  if (signal?.aborted) throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
  const resolved = resolveForMode(entry, context.mode);
  const { params, assetName } = creationOutputParams(resolved, resolved.baseModelParams ? { ...resolved.baseModelParams, ...(context.params || {}) } : context.params);
  const stats = {};
  let baseWorkflow = applyMainModelFile(applyBindings(resolved.workflow, resolved, { ...context, params }, { logger, stats }), resolved.strictModelNames ? "" : resolved.mainModelFile);
  // 图像质量档位（上游 F 项）：fast/quality/ultra + Sage 加速。
  // 本地默认不传档位参数时完全跳过，保证既有出图链零变化；
  // 各 apply* 内部另有 entry.id 守卫，结构不匹配时原样返回。
  const tierRequested = Boolean(params?.krea2Mode || params?.qwenT2iMode || params?.zimageAccel || params?.mossTier || params?.krea2AccelT);
  if (tierRequested) {
    baseWorkflow = applyZImageAccel(
      applyQwenHybridMode(
        applyKrea2Mode(baseWorkflow, { entry: resolved, params, logger }),
        { entry: resolved, params, mode: context.mode, logger },
      ),
      { entry: resolved, params, logger },
    ).workflow;
  }
  const moss = tierRequested ? resolveMossTier(resolved, params) : null;
  if (moss) logger?.info?.(`MOSS 档位 ${moss.tier} → 精度 ${moss.precision}`);
  const bound = baseWorkflow;
  if (resolved.strictModelNames && params?.loras?.some((lora) => lora?.enabled !== false)) {
    throw new GenerationError("创作专用工作流固定使用参考图中的 LoRA，不接受额外注入。", { status: 400, code: "fixed_workflow_loras" });
  }
  const loraResult = applyLoraChain(bound, params, {
    available: loraCatalog,
    filter: resolved.lora?.filter,
    sourceNode: resolved.lora?.source,
    loaderClass: resolved.lora?.loader || "LoraLoaderModelOnly",
  });
  const workflow = applyModelAliases(loraResult.workflow, modelAliasFor, loaderSpecs, resolved);
  const compatibility = workflowModelCompatibilityProblems(resolved, workflow);
  if (compatibility.length) throw new GenerationError(compatibility.map(item => item.message).join("；"), { status: 409, code: "incompatible_workflow_model", details: compatibility });
  if (loraResult.applied.length) {
    logger?.info?.(`LoRA ${entry.name}: ${loraResult.applied.map((item) => `${path.basename(item.name)}@${item.strength}`).join(" -> ")}`);
  }
  const attemptOnce = async () => {
    const submitted = await comfy.submit(workflow, { signal, requestId });
    const promptId = submitted.promptId;
    let running = true;
    let cancelPromise = null;
    const cancel = () => {
      if (!running) return Promise.resolve();
      if (!cancelPromise) {
        cancelPromise = Promise.resolve().then(() => (typeof comfy.cancel === "function" ? comfy.cancel(promptId) : comfy.interrupt(promptId)));
      }
      return cancelPromise;
    };
    const onAbort = () => {
      // 主流程会 await 同一个 Promise；这里只承接事件路径，避免取消失败变成未处理拒绝。
      void cancel().catch(() => {});
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) {
        await cancel();
        throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
      }
      onProgress?.({ phase: "submitted", promptId, progress: 0.05 });

      const timeout = Number(timeoutMs);
      const deadline = timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY;
      let history = null;
      // 轮询期间只上报三个固定点，画布会一直停在 5%，用户以为卡死。
      // 这里按"已经等了多久"折算一个 0.05→0.60 的渐进值，让界面能看出还在走。
      const startedAt = Date.now();
      let lastReported = 0.05;
      let consecutivePollErrors = 0;
      let polls = 0;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await cancel();
          throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
        }
        try {
          polls += 1;
          history = await comfy.history(promptId, { signal });
          consecutivePollErrors = 0;
        } catch (error) {
          if (error?.code === "cancelled" || signal?.aborted) throw error;
          // 轮询偶尔会被对端掐断（"terminated"、ComfyUI 重启、代理抖动）。
          // 任务可能已经跑完了，绝不能因为一次查询失败就判整个生成失败。
          consecutivePollErrors += 1;
          const retryable = error?.code === "comfy_unreachable" || error?.code === "comfy_timeout" || error?.code === "comfy_aborted";
          if (!retryable || consecutivePollErrors > 12) throw error;
          logger?.warn?.(`查询任务 ${promptId} 失败（第 ${consecutivePollErrors} 次），继续等待：${error.message}`);
          await sleep(Math.min(pollIntervalMs * consecutivePollErrors, 5000));
          continue;
        }
        const failure = historyError(history);
        if (failure) {
          running = false;
          throw new GenerationError(`ComfyUI 执行失败：${truncate(failure, 1200)}${failureHint(failure)}`, { status: 502, code: "comfy_execution_failed", details: failure });
        }
        if (historyCompleted(history)) {
          running = false;
          break;
        }
        // 没有真实步数可读时，用一个"渐近"进度：既看已经等了多久，也看轮询了多少次。
        // 只看时长的话，短任务（或测试里 5ms 一轮）永远涨不到 1%，用户看到的还是死进度条。
        const elapsed = Date.now() - startedAt;
        const ratio = Number.isFinite(deadline) ? Math.min(1, elapsed / Math.max(1, deadline - startedAt)) : 0;
        const byTime = Number.isFinite(deadline) ? 0.05 + ratio * 0.55 : Math.min(0.6, 0.05 + (elapsed / 600000) * 0.55);
        // 轮询次数给一个缓慢逼近 0.6 的下界，保证「有动静」，但不超过按时的上限太多。
        const byPolls = 0.05 + 0.55 * (1 - Math.exp(-polls / 40));
        const estimate = Math.min(0.6, Math.max(byTime, byPolls));
        if (estimate > lastReported + 0.01) {
          lastReported = estimate;
          onProgress?.({ phase: "running", promptId, progress: Number(estimate.toFixed(3)) });
        }
        await sleep(pollIntervalMs);
      }
      if (!historyCompleted(history)) {
        let cancelError = null;
        try {
          await cancel();
        } catch (error) {
          cancelError = error;
        } finally {
          running = false;
        }
        if (cancelError) {
          throw new GenerationError(`生成超时，且取消 ComfyUI 任务失败：${cancelError?.message || cancelError}`, {
            status: 504,
            code: "generation_cancel_failed",
            details: { promptId, reason: "generation_timeout", cause: cancelError?.message || String(cancelError) },
          });
        }
        throw new GenerationError("生成超时", { status: 504, code: "generation_timeout" });
      }
      onProgress?.({ phase: "completed", promptId, progress: 0.65 });

      const files = collectOutputFiles(history, { includePreview: includePreviewOutputs });
      if (!files.length) throw new GenerationError("ComfyUI 没有返回任何输出文件", { status: 502, code: "no_output_files" });

      const outputs = [];
      for (const file of files) {
        // 用户已经点停止时不要再读盘：几十 MB 的视频读完也没人要，纯属拖慢取消。
        if (signal?.aborted) throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
        // 本机部署优先读磁盘：history 已经报完成，文件必然落盘，读盘零延迟且不受
        // /view 偶发「200 但不发 body」的影响。远端 ComfyUI（无 comfyDir）仍走 HTTP。
        let viewed = (await readLocalOutput?.(file)) || null;
        if (viewed) {
          logger?.info?.(`${file.filename} 直接从本地输出目录读取（跳过 /view）`);
        } else {
          try {
            viewed = await comfy.view(file, { signal });
          } catch (error) {
            // 下载途中文件才写完、或路径与预期不同，再补一次本地读取。
            const retryLocal = (await readLocalOutput?.(file)) || null;
            if (retryLocal) {
              logger?.warn?.(`取回 ${file.filename} 失败（${error?.message || error}），已改为从本地输出目录读取`);
              viewed = retryLocal;
            } else {
              // 走到这里说明 ComfyUI 已经跑完、文件就在它那边。
              // 把 promptId 和文件名带出去，用户至少能自己从 ComfyUI 输出目录取回，
              // 而不是得到一个「生成失败」后连去哪个文件都不知道。
              throw new GenerationError(`视频已生成，但取回文件失败：${error?.message || error}`, {
                status: 502,
                code: "output_download_failed",
                details: {
                  promptId,
                  filename: file.filename,
                  subfolder: file.subfolder || "",
                  type: file.type || "output",
                  cause: error?.message || String(error),
                },
              });
            }
          }
        }
        const mimeType = /^application\/octet-stream$/i.test(viewed.contentType) ? mimeFromFilename(file.filename) : viewed.contentType;
        outputs.push({
          buffer: viewed.buffer,
          mimeType,
          filename: path.basename(file.filename),
          subfolder: file.subfolder || "",
          type: file.type || "output",
          nodeId: file.nodeId,
          ...(assetName ? { assetName } : {}),
        });
      }
      onProgress?.({ phase: "downloaded", promptId, progress: 0.95 });
      return { promptId, files: outputs, workflow, usedSeed: stats.seed ?? null };
    } catch (error) {
      if (!signal?.aborted) throw error;
      try {
        await cancel();
      } catch (cancelError) {
        throw new GenerationError(`取消 ComfyUI 任务失败：${cancelError?.message || cancelError}`, {
          status: 502,
          code: "generation_cancel_failed",
          details: { promptId, reason: "cancelled", cause: cancelError?.message || String(cancelError) },
        });
      }
      throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  let lastOom = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await attemptOnce();
    } catch (error) {
      if (!isOutOfMemoryError(error) || signal?.aborted) throw error;
      lastOom = error;
      if (attempt === 2) break;
      logger?.warn?.(`ComfyUI 显存不足，释放模型后重试一次：${entry.name}`);
      try {
        await comfy.freeMemory();
      } catch (freeError) {
        logger?.warn?.(`释放显存失败：${freeError.message}`);
      }
      await sleep(1000);
    }
  }
  throw new GenerationError("显存不足：已自动释放模型并重试一次仍然失败。请降低分辨率 / 张数，或先关闭其他占用显存的程序再试。", {
    status: 507,
    code: "comfy_out_of_memory",
    details: lastOom?.details || lastOom?.message,
  });
}

export async function runImage({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, onProgress, logger, loraCatalog, modelAliasFor = null, loaderSpecs = MODEL_LOADER_SPECS, includePreviewOutputs = false, readLocalOutput = null }) {
  const count = context.count || 1;
  const all = [];
  let lastPromptId;
  let lastUsedSeed = null;
  // 工作流如果支持 batch，一次就能返回 count 张；不支持时按张补跑，避免画布静默少图。
  for (let attempt = 0; attempt < count && all.length < count; attempt += 1) {
    const result = await runWorkflow({
      entry,
      context,
      comfy,
      timeoutMs,
      pollIntervalMs,
      signal,
      requestId,
      logger,
      loraCatalog,
      modelAliasFor,
      loaderSpecs,
      includePreviewOutputs,
      readLocalOutput,
      onProgress: (event) => onProgress?.({ ...event, attempt, attempts: count }),
    });
    lastPromptId = result.promptId;
    lastUsedSeed = result.usedSeed ?? lastUsedSeed;
    all.push(...result.files);
  }
  return { promptId: lastPromptId, files: all.slice(0, count), usedSeed: lastUsedSeed };
}

export async function runVideo({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, onProgress, logger, loraCatalog, modelAliasFor = null, loaderSpecs = MODEL_LOADER_SPECS, includePreviewOutputs = false, readLocalOutput = null }) {
  const result = await runWorkflow({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, logger, loraCatalog, modelAliasFor, loaderSpecs, includePreviewOutputs, onProgress, readLocalOutput });
  const video = result.files.find((file) => {
    const bytes = file.buffer;
    const imageBytes = bytes?.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
      (bytes?.[0] === 0xff && bytes?.[1] === 0xd8) || /^GIF8[79]a/.test(bytes?.subarray(0, 6).toString() || "") ||
      (bytes?.subarray(0, 4).toString() === "RIFF" && bytes?.subarray(8, 12).toString() === "WEBP");
    if (file.type === "temp" || /^image\//i.test(file.mimeType) || imageBytes) return false;
    return /^video\//i.test(file.mimeType) || /\.(mp4|webm|mov|mkv)$/i.test(file.filename);
  });
  if (!video) {
    throw new GenerationError("视频工作流没有返回视频文件（只拿到了图片/动图）", { status: 502, code: "no_video_output", details: result.files.map((file) => file.filename) });
  }
  return { promptId: result.promptId, files: [video] };
}

// 音频（音色设计 / 音色克隆 / 音乐生成）产物：按 mime 或扩展名挑一条，优先非 temp。
export async function runAudio({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, onProgress, logger, modelAliasFor = null, loaderSpecs = MODEL_LOADER_SPECS, includePreviewOutputs = false, readLocalOutput = null }) {
  const result = await runWorkflow({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, logger, modelAliasFor, loaderSpecs, includePreviewOutputs, onProgress, readLocalOutput });
  const audio = result.files.find((file) => {
    if (file.type === "temp") return false;
    return /^audio\//i.test(file.mimeType) || /\.(flac|mp3|opus|wav|ogg|m4a)$/i.test(file.filename);
  });
  if (!audio) {
    throw new GenerationError("音频工作流没有返回音频文件", { status: 502, code: "no_audio_output", details: result.files.map((file) => file.filename) });
  }
  return { promptId: result.promptId, files: [audio], usedSeed: result.usedSeed ?? null };
}

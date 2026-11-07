import { normalizeLocalPromptTimeoutSeconds } from "./prompt-local-timeout.js";
import { promptCloudFetch } from "./prompt-cloud-timeout.js";
import { selectKvmemVision } from "./kvmem-vision.js";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const EXE = ["workers", "ninfer", "ninfer-kvmem-server.exe"];
const MAX_JSON_BYTES = 2 * 1024 * 1024;

function failure(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
const cancelled = () => failure("kvmem_cancelled", "本地图片反推已取消", 499);
const releaseFailure = () => failure("kvmem_release_failed", "无法确认 KVMem worker 已退出；暂不允许启动其他 GPU 任务", 503);
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;

// Reserve only an unused loopback port. The socket must be released before the
// native worker binds it; a random API key/model ID fail closed across that race.
async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(failure("kvmem_port_failed", "无法分配本地 worker 端口")));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(failure("kvmem_port_failed", "无法释放 worker 预留端口")) : resolve(port));
    });
  });
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
async function jsonResponse(response, signal) {
  try {
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await abortable(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > MAX_JSON_BYTES) throw failure("kvmem_bad_response", "KVMem 响应超出限制");
          chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString("utf8");
      } finally { reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else {
      text = await abortable(response.text(), signal);
      if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw failure("kvmem_bad_response", "KVMem 响应超出限制");
    }
    return JSON.parse(text);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error?.code === "kvmem_bad_response") throw error;
    throw failure("kvmem_bad_response", "KVMem 未返回有效 JSON");
  }
}
function visionEnabled(props) {
  // An object such as {enabled:false} must never become true through Boolean().
  for (const value of [props?.modalities?.vision, props?.kvmem?.vision?.enabled, props?.kvmem?.vision]) {
    if (typeof value === "boolean") return value;
  }
  return false;
}

/** Each caption owns exactly one native process; never discovers/attaches/kills
 * an external service. Call close() from orderly gateway/app shutdown. Direct
 * child handles are used, not process-name or port-based kill commands. This
 * module does not claim Windows Job Object protection after a host hard crash.
 */
export function createKvmemRuntime({
  config = {}, logger, spawnImpl = spawn, fetchImpl = promptCloudFetch,
  freePort = freeLoopbackPort, fileExists = isFile, now = Date.now,
  pollIntervalMs = 200, probeTimeoutMs = 2000, stopTimeoutMs = 5000,
} = {}) {
  let active = null;
  let shuttingDown = false;
  const exe = config.installDir ? path.join(config.installDir, ...EXE) : "";
  const model = config.modelPath || "";
  const startupMs = positive(config.startupTimeoutMs, 180000);
  const requestMs = positive(config.requestTimeoutMs, 600000);

  function capability() {
    const reasons = [];
    if (config.enabled !== true) reasons.push("KVMem 本地反推未启用");
    if (!exe || !path.isAbsolute(exe) || !fileExists(exe)) reasons.push("未找到指定安装目录的 NInfer worker");
    if (!model || !path.isAbsolute(model) || path.extname(model).toLowerCase() !== ".ninfer" || !fileExists(model)) reasons.push("请选择存在的 .ninfer 模型文件");
    if (!['cpu', 'gpu', 'auto'].includes(config.visionMode ?? 'cpu')) reasons.push("KVMem 视觉模式必须是 cpu、gpu 或 auto");
    if (shuttingDown) reasons.push("KVMem runtime 已关闭");
    return { id: "kvmem", label: "KVMem / NInfer", enabled: config.enabled === true, available: !reasons.length,
      visionMode: config.visionMode ?? "cpu", reasons, missingResources: [], missingNodes: [] };
  }

  function ownChild(run, child) {
    run.child = child;
    run.closedPromise = new Promise((resolve) => {
      child.once("close", (code) => {
        run.closed = true;
        run.exitCode = Number.isInteger(code) ? code : null;
        resolve();
        if (run.settled && active === run) active = null;
        if (!run.stopping) run.controller.abort(failure("kvmem_worker_exited", "KVMem worker 在任务完成前退出"));
      });
      child.on("error", () => {
        // ENOENT/etc creates no native process, but Node still emits close.
        run.controller.abort(failure("kvmem_spawn_failed", "KVMem worker 启动或进程操作失败"));
      });
    });
  }

  async function release(run) {
    if (!run.child || run.closed) return;
    run.stopping = true;
    // Windows Node's kill terminates this specific owned process; it is not a
    // worker HTTP shutdown API. No global taskkill or unrelated PID is used.
    try { run.child.kill("SIGTERM"); } catch { /* retry only this owned handle */ }
    if (await within(run.closedPromise, stopTimeoutMs)) return;
    try { run.child.kill("SIGKILL"); } catch { /* close confirmation is authoritative */ }
    if (!(await within(run.closedPromise, stopTimeoutMs))) throw releaseFailure();
  }

  async function request(run, route, { body, probe = false } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(run.controller.signal.reason);
    run.controller.signal.addEventListener("abort", abort, { once: true });
    if (run.controller.signal.aborted) abort();
    const timer = probe ? setTimeout(() => controller.abort(failure("kvmem_probe_timeout", "KVMem 就绪探测超时")), probeTimeoutMs) : null;
    try {
      const response = await abortable(fetchImpl(run.base + route, {
        method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
        timeoutMs: probe ? probeTimeoutMs : run.requestMs,
        headers: { Authorization: `Bearer ${run.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), controller.signal);
      if (route === "/health") {
        await response.body?.cancel?.().catch(() => {});
        return response.status;
      }
      if (response.status !== 200) {
        await response.body?.cancel?.().catch(() => {});
        // Deliberately do not expose server bodies: they can contain user data.
        throw failure("kvmem_http_error", `KVMem HTTP 请求失败 (${Number(response.status) || 0})`);
      }
      return await jsonResponse(response, controller.signal);
    } catch (error) {
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (typeof error?.code === "string" && error.code.startsWith("kvmem_")) throw error;
      if (error?.code === "cloud_api_timeout") throw failure(probe ? "kvmem_probe_timeout" : "kvmem_request_timeout", probe ? "KVMem 就绪探测超时" : "KVMem 图片反推超时", 504);
      throw failure("kvmem_connection_failed", "无法连接专有 KVMem worker");
    } finally {
      clearTimeout(timer);
      run.controller.signal.removeEventListener("abort", abort);
    }
  }

  async function execute(run, { imageDataUrl, systemPrompt, userPrompt, signal, hardware }) {
    const started = now();
    const vision = selectKvmemVision(config.visionMode ?? "cpu", hardware);
    const abort = () => run.controller.abort(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer;
    try {
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      if (vision.mode === "gpu" && !vision.admitted) throw failure("kvmem_insufficient_vram", "未确认 GPU 视觉模式所需空闲显存，未启动 worker", 409);
      timer = setTimeout(() => run.controller.abort(failure("kvmem_startup_timeout", "KVMem worker 启动超时", 504)), startupMs);
      const port = await abortable(freePort(), run.controller.signal);
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure("kvmem_port_failed", "无效的 worker 端口");
      run.base = `http://127.0.0.1:${port}`;
      run.modelId = `canvas-caption-${randomUUID()}`;
      run.key = randomBytes(32).toString("hex");
      const args = [model, "--host", "127.0.0.1", "--port", String(port), "--model-id", run.modelId, "--api-key", run.key,
        "--device", "0", "--max-context", "8192", "--max-concurrency", "1", "--default-max-tokens", "1024",
        "--prefill-chunk", "128", "--kv-dtype", "int8", "--kvmem", "--kvmem-budget", "2048",
        "--kvmem-gen-reserve", "512", "--kvmem-host-mib", "1024", "--kvmem-sink-tokens", "64",
        "--kvmem-recent-tokens", "64", "--kvmem-sessions", "1", ...(vision.mode === "gpu" ? ["--vision", "--vision-residency", "resident"] : ["--vision-cpu"]), "--vision-max-merged", "1024",
        "--spec", "none", "--ngram-draft-tokens", "0", "--no-thinking", "--device-profile", "off",
        "--no-cuda-graph", "--media-cache-mib", "0", "--no-webui"];
      try {
        ownChild(run, spawnImpl(exe, args, { cwd: path.dirname(exe), shell: false, windowsHide: true,
          stdio: "ignore", env: { ...process.env, CUDA_VISIBLE_DEVICES: String(config.gpuDevice || "0"), CUDA_DEVICE_ORDER: "PCI_BUS_ID" } }));
      } catch { throw failure("kvmem_spawn_failed", "无法启动 KVMem worker"); }
      for (;;) {
        if (run.controller.signal.aborted) throw run.controller.signal.reason;
        let status;
        try { status = await request(run, "/health", { probe: true }); }
        catch (error) {
          if (run.controller.signal.aborted) throw run.controller.signal.reason;
          if (!["kvmem_connection_failed", "kvmem_probe_timeout"].includes(error.code)) throw error;
        }
        if (status === 200) break;
        if (status === 401 || status === 403) throw failure("kvmem_identity_mismatch", "worker 认证不匹配；拒绝连接已有服务");
        await pause(pollIntervalMs, run.controller.signal);
      }
      const models = await request(run, "/v1/models", { probe: true });
      if (!Array.isArray(models?.data) || models.data.length !== 1 || models.data[0]?.id !== run.modelId) {
        throw failure("kvmem_identity_mismatch", "worker 模型身份不匹配；拒绝使用已有服务");
      }
      const props = await request(run, "/props", { probe: true });
      if (props?.backend !== "ninfer" || !visionEnabled(props)) {
        throw failure("kvmem_capability_mismatch", "专有 worker 未确认 NInfer 图像能力");
      }
      clearTimeout(timer);
      timer = setTimeout(() => run.controller.abort(failure("kvmem_request_timeout", "KVMem 图片反推超时", 504)), run.requestMs);
      const response = await request(run, "/v1/chat/completions", { body: {
        model: run.modelId, stream: false, max_tokens: 1024, temperature: 0.2, reasoning_effort: "none",
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: [{ type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "auto" } }] },
        ],
      } });
      if (response?.model !== run.modelId) throw failure("kvmem_identity_mismatch", "反推响应模型身份不匹配");
      const choice = response?.choices?.[0];
      const prompt = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
      if (!prompt) throw failure("kvmem_empty_output", "KVMem 未返回有效图片描述");
      if (!["stop", "length"].includes(choice.finish_reason)) throw failure("kvmem_incomplete_output", "KVMem 未正常完成图片描述");
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      // finally must confirm close before this pending return becomes observable.
      return { prompt, engine: "kvmem", elapsedMs: Math.max(0, now() - started), released: true,
        modelName: path.basename(model), truncated: choice.finish_reason === "length", visionMode: vision.mode,
        visionRequested: vision.requested, visionSelectionReason: vision.reason };
    } finally {
      clearTimeout(timer);
      try { await release(run); }
      catch (error) {
        // Fixed diagnostic only: never log argv, keys, paths, prompts or stderr.
        try { logger?.warn?.("KVMem worker exit was not confirmed"); } catch { /* logging cannot change ownership */ }
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        run.settled = true;
        if ((!run.child || run.closed) && active === run) active = null;
      }
      // A cancellation/close arriving while cleanup waited must not publish a
      // pending successful result after the caller has cancelled the operation.
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
    }
  }

  function caption(input = {}) {
    if (shuttingDown) return Promise.reject(failure("kvmem_closed", "KVMem runtime 已关闭", 503));
    if (active) return Promise.reject(failure("kvmem_busy", "KVMem 正在处理另一任务或等待 worker 退出", 409));
    if (!capability().available) return Promise.reject(failure("kvmem_unavailable", "KVMem 本地 worker 或模型不可用", 503));
    if (typeof input.imageDataUrl !== "string" || input.imageDataUrl.length > 32 * 1024 * 1024 ||
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imageDataUrl)) {
      return Promise.reject(failure("kvmem_invalid_image", "需要本地 PNG/JPEG/WebP 的 base64 data URL", 400));
    }
    if (typeof input.userPrompt !== "string" || !input.userPrompt.trim() || input.userPrompt.length > 12000 ||
        (input.systemPrompt != null && (typeof input.systemPrompt !== "string" || input.systemPrompt.length > 12000))) {
      return Promise.reject(failure("kvmem_invalid_prompt", "图片描述指令为空或超出限制", 400));
    }
    let effectiveRequestMs;
    try { effectiveRequestMs = input.timeoutSeconds === undefined ? requestMs : normalizeLocalPromptTimeoutSeconds(input.timeoutSeconds) * 1000; }
    catch (error) { return Promise.reject(error); }
    const run = { controller: new AbortController(), child: null, closed: false, settled: false, stopping: false, requestMs: effectiveRequestMs };
    active = run; // Synchronous reservation rejects competing requests before any await.
    const operation = execute(run, input);
    run.done = operation.then(() => {}, () => {});
    return operation;
  }

  async function close() {
    shuttingDown = true;
    const run = active;
    if (!run) return;
    run.controller.abort(cancelled());
    await run.done;
    if (active === run) {
      await release(run); // Retry a previous unconfirmed owned-child cleanup only.
      if (run.closed || !run.child) active = null;
    }
  }
  return { capability, caption, close, isBusy: () => active !== null };
}

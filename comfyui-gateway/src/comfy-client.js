import fsp from "node:fs/promises";
import path from "node:path";

import { estimateStepPlan } from "./step-plan.js";
import { randomId, sleep, truncate } from "./util.js";

export class ComfyUIError extends Error {
  constructor(message, { status = 502, code = "comfy_error", details, httpStatus } = {}) {
    super(message);
    this.name = "ComfyUIError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function formatNodeErrors(nodeErrors) {
  if (!nodeErrors || typeof nodeErrors !== "object") return "";
  const messages = [];
  for (const [nodeId, value] of Object.entries(nodeErrors)) {
    const errors = Array.isArray(value?.errors) ? value.errors : [];
    for (const error of errors) {
      messages.push(`节点 ${nodeId}: ${error.message || error.details || "校验失败"}`);
    }
    if (!errors.length && value) messages.push(`节点 ${nodeId}: ${truncate(JSON.stringify(value), 300)}`);
  }
  return messages.slice(0, 8).join("；");
}

export function createComfyClient({ baseUrl, timeoutMs = 10 * 60 * 1000, downloadTimeoutMs = 60 * 60 * 1000, retryAttempts = 3, retryDelayMs = 500, logger, previewHub, autoDiscover = true, selfPorts = [], localOutputDirs = [] } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("ComfyUI baseUrl 不能为空");
  let activeBase = base;
  let lastDiscoverAt = 0;
  let discovery = null;

  function loopbackHost() {
    try {
      return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(base).hostname);
    } catch {
      return false;
    }
  }

  function candidateBases() {
    if (!loopbackHost()) return [base];
    const ports = new Set();
    const add = (value) => {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
    };
    try {
      add(new URL(base).port || (new URL(base).protocol === "https:" ? 443 : 80));
    } catch {
      /* 配置地址异常时只扫默认端口 */
    }
    for (const port of [8188, 8000, 7860, 8080, 8888, 18000]) add(port);
    for (const value of String(process.env.COMFY_PORT_SCAN || "").split(",")) add(value.trim());
    for (let port = 8190; port <= 8199; port += 1) add(port);
    // 必须排掉网关自己：网关默认就监听 8190，而候选里正好包含 8190-8199。
    // 不排除的话探活会打到网关自身，一旦某个路由恰好回 2xx 就会把
    // activeBase 切到自己身上，之后所有 ComfyUI 调用（history/view/download）
    // 全部打空 —— 现场表现为「视频早就生成好了，网关却一直卡在 s5_video
    // 轮询到 20 分钟超时」。
    // 自身端口来源有两个：显式传入（推荐，来自 config.port）与 PORT 环境变量。
    const ownPorts = new Set(
      [...selfPorts, process.env.PORT]
        .map((value) => Number(value))
        .filter((port) => Number.isInteger(port) && port > 0),
    );
    // 另外用监听地址兜底：base 若本身指向本机某端口，那个端口也不是 ComfyUI。
    for (const port of ownPorts) ports.delete(port);
    return [...ports].map((port) => `http://127.0.0.1:${port}`);
  }

  async function probeBase(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`${url}/system_stats`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // 启动器可能还没探测到 ComfyUI，或整合包自己换了端口；
  // 连不上时扫一遍本机常见端口，避免画布永久停在“离线/识别不到”。
  async function discoverBase({ force = false } = {}) {
    if (!autoDiscover || !loopbackHost()) return "";
    if (discovery) return discovery;
    if (!force && Date.now() - lastDiscoverAt < 15000) return "";
    discovery = (async () => {
      const hits = await Promise.all(candidateBases().map(async (url) => (await probeBase(url) ? url : "")));
      const found = hits.find(Boolean) || "";
      if (found && found !== activeBase) {
        logger?.warn?.(`ComfyUI 地址自动切换：${activeBase} → ${found}`);
        activeBase = found;
      }
      return found;
    })().finally(() => {
      discovery = null;
      lastDiscoverAt = Date.now();
    });
    return discovery;
  }

  async function requestOnce(pathname, { method = "GET", body, headers = {}, signal, timeout = timeoutMs, raw = false } = {}) {
    const controller = new AbortController();
    // 超时是「多久没有进展」，不是「总共多久」。下载大文件时只要还在收数据就不该被杀，
    // 否则 40 分钟的视频任务会因为前 10 分钟没下完而被判超时——文件其实早就生成好了。
    let timedOut = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      if (!(timeout > 0)) return;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("ComfyUI 请求超时"));
      }, timeout);
    };
    arm();
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetch(`${activeBase}${pathname}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "follow",
      });
      if (raw) {
        if (!response.ok) throw new ComfyUIError(`ComfyUI ${pathname} 返回 ${response.status}`, { status: 502, code: "comfy_http_error", httpStatus: response.status });
        // 边收边推超时：每收到一块数据就重置计时，慢但活着的下载不会被误杀。
        if (!response.body || typeof response.body.getReader !== "function") {
          return {
            buffer: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get("content-type") || "application/octet-stream",
          };
        }
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            chunks.push(Buffer.from(value));
            received += value.byteLength;
            arm();
          }
        }
        return {
          buffer: Buffer.concat(chunks, received),
          contentType: response.headers.get("content-type") || "application/octet-stream",
        };
      }
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        const rawMessage = data?.error?.message || data?.error || data?.raw || `ComfyUI ${pathname} 返回 ${response.status}`;
        const baseMessage = typeof rawMessage === "string" ? rawMessage : JSON.stringify(rawMessage);
        const nodeMessage = formatNodeErrors(data?.node_errors);
        const message = nodeMessage && !baseMessage.includes(nodeMessage) ? `${baseMessage}；${nodeMessage}` : baseMessage;
        throw new ComfyUIError(truncate(message, 1200), {
          status: response.status === 400 ? 400 : 502,
          code: "comfy_http_error",
          details: data,
          httpStatus: response.status,
        });
      }
      return data;
    } catch (error) {
      if (error instanceof ComfyUIError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new ComfyUIError("ComfyUI 请求已取消或超时", { status: 504, code: timedOut ? "comfy_timeout" : "comfy_aborted", details: error?.message || String(error) });
      }
      // undici 在连接被对端提前关闭时抛 "terminated"。这类错误是可重试的瞬时故障，
      // 不能当成「ComfyUI 挂了」直接让任务失败。
      throw new ComfyUIError(`无法连接 ComfyUI：${error?.message || error}`, { status: 502, code: "comfy_unreachable", cause: error?.code || error?.cause?.code || "" });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  function isRetryable(error) {
    // 超时说明时间预算已经耗尽，再试一轮只会把等待翻倍——直接交给上层。
    if (error?.code === "comfy_timeout" || error?.code === "comfy_aborted") return false;
    if (error?.code === "comfy_unreachable") return true;
    return error?.code === "comfy_http_error" && Number(error.httpStatus) >= 500;
  }

  // 只重试 GET；提交/上传类 POST 重试可能造成重复任务。
  async function request(pathname, options = {}) {
    const attempts = options.method && options.method !== "GET" ? 1 : Math.max(1, Number(retryAttempts) || 1);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await requestOnce(pathname, options);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !isRetryable(error) || options.signal?.aborted) throw error;
        // 下载（raw）请求期间不做地址重定位。
        // discoverBase 会并发 fetch 十几个候选端口、每个 1.5s 后 abort，
        // 而大视频下载正好在慢速传输中 —— 这些探活请求会挤占同一个
        // undici 连接池，把下载连接撞成 "terminated"，于是「视频早已生成好，
        // 网关却反复重试下载直到 20 分钟超时」。下载失败只重试，不挪地址。
        if (error?.code === "comfy_unreachable" && !options.raw) {
          // 已经是本机回环地址还报「连不上」，多半是 ComfyUI 正在重启或端口漂移；
          // 先重新定位，别盲目重试同一个死端口。
          const found = await discoverBase({ force: attempt > 1 });
          if (found) {
            logger?.warn?.(`ComfyUI 已重新定位到 ${found}，重试 ${pathname}`);
          }
        }
        logger?.warn?.(`ComfyUI ${pathname} 第 ${attempt} 次请求失败，${retryDelayMs * attempt}ms 后重试：${error.message}`);
        await sleep(retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  async function submit(workflow, { clientId = randomId("canvas-"), signal, requestId } = {}) {
    if (previewHub) {
      await previewHub.ensure(clientId).catch(() => false);
    }
    const data = await request("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal,
    });
    const nodeErrors = formatNodeErrors(data?.node_errors);
    if (nodeErrors) {
      throw new ComfyUIError(`ComfyUI 工作流校验失败：${nodeErrors}`, { status: 400, code: "node_errors", details: data.node_errors });
    }
    if (!data?.prompt_id) {
      throw new ComfyUIError(`ComfyUI 未返回 prompt_id：${truncate(JSON.stringify(data), 500)}`, { status: 502, code: "no_prompt_id", details: data });
    }
    previewHub?.bindPrompt(clientId, data.prompt_id, { requestId, plan: estimateStepPlan(workflow) });
    return { promptId: data.prompt_id, number: data.number, raw: data };
  }

  async function history(promptId, { signal } = {}) {
    const data = await request(`/history/${encodeURIComponent(promptId)}`, { signal });
    return data?.[promptId] || data?.[String(promptId)] || null;
  }

  /**
   * 从本机磁盘直接读 ComfyUI 的输出文件。
   *
   * 为什么需要这条路：现场遇到 ComfyUI 的 /view 端点回 200、响应头里
   * Content-Length 也正确（1472202），但**响应体是 0 字节**，连接不发数据；
   * 同一次会话里 /object_info 能正常返回 6.6MB，说明服务整体是好的，
   * 坏的只有 /view（Windows 上带反斜杠 subfolder 的大文件尤其容易触发）。
   * 一旦走到这条路，重试多少次都没用，任务会卡死到超时。
   *
   * 本地目录可用时直接读文件，完全绕开这个端点。
   */
  async function readLocalOutput(file) {
    // 支持惰性求值：setup 在 client 之后才创建，构造时还拿不到 ComfyUI 根目录。
    const roots = typeof localOutputDirs === "function" ? (await localOutputDirs()) || [] : localOutputDirs;
    if (!Array.isArray(roots) || !roots.length) return null;
    const subfolder = String(file.subfolder || "").replace(/\\/g, "/");
    const filename = String(file.filename || "");
    if (!filename) return null;
    for (const root of roots) {
      if (!root) continue;
      const candidate = path.resolve(root, subfolder, filename);
      // 防目录穿越：解析后必须仍在 root 之内。
      const rootResolved = path.resolve(root);
      if (!candidate.startsWith(rootResolved + path.sep) && candidate !== rootResolved) continue;
      try {
        const stat = await fsp.stat(candidate);
        if (!stat.isFile() || stat.size === 0) continue;
        const buffer = await fsp.readFile(candidate);
        if (!buffer.length) continue;
        logger?.info?.(`ComfyUI /view 不可用，已从本地文件读取 ${path.basename(candidate)}（${buffer.length} 字节）`);
        return { buffer, contentType: guessContentType(filename) };
      } catch {
        // 该目录下没有这个文件，试下一个。
      }
    }
    return null;
  }

  function guessContentType(name) {
    const ext = path.extname(String(name || "")).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".mp4") return "video/mp4";
    if (ext === ".webm") return "video/webm";
    if (ext === ".mp3") return "audio/mpeg";
    if (ext === ".wav") return "audio/wav";
    return "application/octet-stream";
  }

  async function view(file, { signal, timeout = downloadTimeoutMs } = {}) {
    const params = new URLSearchParams({
      filename: String(file.filename || ""),
      subfolder: String(file.subfolder || ""),
      type: String(file.type || "output"),
    });
    // 先用本地文件：ComfyUI 的 /view 在 Windows 上会「200 + Content-Length 正确
    // 但响应体 0 字节」，重试无解（详见 readLocalOutput 注释）。本地能读到就直接用，
    // 既快又不会把任务卡死。
    const local = await readLocalOutput(file).catch(() => null);
    if (local) return local;
    // 下载用独立的超时预算：它比普通 API 慢得多，混用同一个 10 分钟会让大文件永远失败。
    try {
      return await request(`/view?${params.toString()}`, { raw: true, signal, timeout });
    } catch (error) {
      // HTTP 走不通时再兜一次本地（文件可能刚落盘）。
      const retryLocal = await readLocalOutput(file).catch(() => null);
      if (retryLocal) return retryLocal;
      throw error;
    }
  }

  async function uploadImage(buffer, filename = "input.png", mimeType = "image/png") {
    const form = new FormData();
    form.append("image", new Blob([buffer], { type: mimeType || "image/png" }), filename);
    form.append("overwrite", "true");
    const data = await request("/upload/image", { method: "POST", body: form, timeout: Math.min(timeoutMs, 120000) });
    if (!data?.name) {
      throw new ComfyUIError(`ComfyUI 上传图片失败：${truncate(JSON.stringify(data), 500)}`, { status: 502, code: "upload_failed", details: data });
    }
    return { name: data.name, subfolder: data.subfolder || "", type: data.type || "input" };
  }

  async function interrupt(promptId, { signal } = {}) {
    try {
      await request("/interrupt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
        timeout: 5000,
        signal,
      });
    } catch (error) {
      logger?.warn?.(`interrupt failed: ${error.message}`);
      throw error;
    }
  }

  // 同时删掉排队项并打断当前采样；运行项删除失败可由 interrupt 兜底，但打断失败不能静默成功。
  async function cancel(promptId, { signal } = {}) {
    const tasks = [
      request("/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
        timeout: 5000,
        signal,
      }).catch((error) => logger?.warn?.(`queue delete failed: ${error.message}`)),
      interrupt(promptId, { signal }),
    ];
    const results = await Promise.allSettled(tasks);
    if (results[1].status === "rejected") throw results[1].reason;
  }

  const freeMemory = () =>
    request("/free", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      timeout: 15000,
    });

  const objectInfo = ({ signal } = {}) => request("/object_info", { timeout: 30000, signal });
  const systemStats = () => request("/system_stats", { timeout: 3000 });
  // ComfyUI 会把 extra_model_paths.yaml / 目录映射后的真实路径都列出来；
  // 老版本没有这个接口时返回空对象，由调用方回退到 models/<类型>。
  const folderPaths = async () => {
    try {
      const data = await request("/internal/folder_paths", { timeout: 5000 });
      return data && typeof data === "object" ? data : {};
    } catch (error) {
      logger?.warn?.(`读取 ComfyUI 模型目录失败：${error.message}`);
      return {};
    }
  };
  const queue = () => request("/queue", { timeout: 5000 });

  async function isReachable() {
    try {
      await systemStats();
      return true;
    } catch {
      return false;
    }
  }

  return { baseUrl: () => activeBase, configuredBaseUrl: () => base, request, submit, history, view, uploadImage, interrupt, cancel, freeMemory, objectInfo, systemStats, folderPaths, queue, isReachable };
}

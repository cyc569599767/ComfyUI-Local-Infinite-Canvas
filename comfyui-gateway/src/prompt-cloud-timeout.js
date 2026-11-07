import http from "node:http";
import https from "node:https";

export const DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS = 600;
export const MIN_PROMPT_CLOUD_TIMEOUT_SECONDS = 30;
export const MAX_PROMPT_CLOUD_TIMEOUT_SECONDS = 1800;

class PromptCloudError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "PromptCloudError";
    this.status = status;
    this.code = code;
  }
}

// Multipart fields are strings; internal callers may pass a number. Do not
// coerce booleans, arrays, whitespace-only strings, fractions or numeric syntax
// such as hex/exponents into a valid configuration by accident.
export function normalizePromptCloudTimeoutSeconds(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS;
  const seconds = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(seconds) || seconds < MIN_PROMPT_CLOUD_TIMEOUT_SECONDS || seconds > MAX_PROMPT_CLOUD_TIMEOUT_SECONDS) {
    throw new PromptCloudError("云端 API 超时必须为 30～1800 秒的整数", 400, "cloud_invalid_timeout");
  }
  return seconds;
}

// Node's bundled fetch has its own ~300s headers/body limits. A per-request
// native transport avoids that hidden ceiling without changing a global fetch
// dispatcher or adding a dependency. It never retries/resubmits a request.
// The caller owns the total deadline; setTimeout only bounds socket inactivity.
export function promptCloudFetch(endpoint, { method, headers, body, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const request = url.protocol === "https:" ? https.request : http.request;
    let outgoing;
    let upstream;
    let finished = false;
    let resolveBody;
    let rejectBody;
    const bodyResult = new Promise((yes, no) => { resolveBody = yes; rejectBody = no; });
    // A disconnect may happen before the consumer reaches response.text().
    bodyResult.catch(() => {});
    const cleanup = () => signal?.removeEventListener("abort", aborted);
    const failed = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
      rejectBody(error);
      upstream?.destroy();
      outgoing?.destroy();
    };
    const disconnected = () => new Error("云端 API 连接在响应完成前中断");
    const aborted = () => failed(signal.reason || new PromptCloudError("云端 API 请求已取消", 499, "cloud_api_cancelled"));
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      outgoing = request(url, { method, headers: { "accept-encoding": "identity", ...headers }, signal, agent: false }, (response) => {
        upstream = response;
        if (finished) { response.destroy(); return; }
        const status = response.statusCode || 502;
        if (status >= 300 && status < 400) {
          // Do not forward credentials to redirects or wait for their bodies.
          finished = true;
          cleanup();
          resolveBody("");
          resolve({ status, ok: false, text: () => bodyResult });
          response.destroy();
          outgoing?.destroy();
          return;
        }
        let text = "";
        let size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > 16 * 1024 * 1024) {
            failed(new PromptCloudError("云端 API 响应超过大小限制", 502, "cloud_api_failed"));
            return;
          }
          text += chunk;
        });
        response.on("error", failed);
        response.once("aborted", () => failed(disconnected()));
        response.once("close", () => { if (!response.complete) failed(disconnected()); });
        response.once("end", () => {
          if (finished) return;
          finished = true;
          cleanup();
          resolveBody(text);
        });
        resolve({ status, ok: status >= 200 && status < 300, text: () => bodyResult });
      });
      outgoing.on("error", failed);
      outgoing.once("close", () => { if (!upstream) failed(disconnected()); });
      outgoing.setTimeout(timeoutMs, () => failed(new PromptCloudError("云端 API 请求超时", 504, "cloud_api_timeout")));
      outgoing.end(body);
    } catch (error) {
      failed(error);
    }
  });
}

// One deadline for headers, response body, and the optional temperature retry.
// run() races even implementations that ignore AbortSignal; a late rejection is
// still observed, and listeners are removed as soon as either side settles.
export function createPromptCloudDeadline({ timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const timeout = () => controller.abort(new PromptCloudError("云端 API 请求超时", 504, "cloud_api_timeout"));
  const cancelled = () => controller.abort(new PromptCloudError("云端 API 请求已取消", 499, "cloud_api_cancelled"));
  const timer = setTimeout(timeout, timeoutMs);
  if (signal?.aborted) cancelled();
  else signal?.addEventListener("abort", cancelled, { once: true });

  const throwIfAborted = () => {
    if (!controller.signal.aborted && Date.now() >= expiresAt) timeout();
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    throwIfAborted,
    run(operation) {
      return new Promise((resolve, reject) => {
        try { throwIfAborted(); } catch (error) { reject(error); return; }
        const cleanup = () => controller.signal.removeEventListener("abort", aborted);
        const aborted = () => { cleanup(); reject(controller.signal.reason); };
        controller.signal.addEventListener("abort", aborted, { once: true });
        // Defer invocation until the abort listener is attached, and recheck so
        // a cancellation between two stages never starts another HTTP request.
        Promise.resolve().then(() => { throwIfAborted(); return operation(); }).then((value) => {
          cleanup();
          try { throwIfAborted(); resolve(value); } catch (error) { reject(error); }
        }, (error) => { cleanup(); reject(controller.signal.aborted ? controller.signal.reason : error); });
      });
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
    },
  };
}

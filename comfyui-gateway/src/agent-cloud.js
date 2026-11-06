import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AgentCloudError, parseAgentCloudFormat, applyAgentCloudEndpoint, agentCloudAuthHeaders,
  prepareAgentCloudRequest, createAgentCloudNormalizer, normalizeAgentCloudModels } from "./agent-cloud-protocols.js";

// This transport intentionally owns no credential store, logger, retry policy, or disk IO.
const REQUEST_LIMIT = 42 * 1024 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const EVENT_LIMIT = 1024 * 1024;
const fail = (code, message, status) => { throw new AgentCloudError(code, message, status); };
const bareHost = (host) => String(host || "").toLowerCase().replace(/^\[|\]$/g, "");

function ipv6Words(address) {
  let source = bareHost(address);
  if (source.includes(".")) {
    const index = source.lastIndexOf(":");
    const bytes = source.slice(index + 1).split(".").map(Number);
    source = `${source.slice(0, index)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = source.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const parts = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return parts.map((part) => parseInt(part, 16));
}

function isLiteralLoopback(address) {
  const host = bareHost(address);
  if (isIP(host) === 4) return Number(host.split(".")[0]) === 127;
  if (isIP(host) !== 6) return false;
  const words = ipv6Words(host);
  return words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
}

function isLoopbackPeer(address) {
  const host = bareHost(address);
  if (isLiteralLoopback(host)) return true;
  if (isIP(host) !== 6) return false;
  const words = ipv6Words(host);
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff && (words[6] >>> 8) === 127;
}

export function isPublicAgentCloudAddress(address) {
  const host = bareHost(address);
  if (isIP(host) === 4) {
    const [a, b, c] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(host) !== 6) return false;
  const [a, b] = ipv6Words(host);
  // Permit only global unicast. Exclude mapped, local, transition, special-use and documentation space.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 &&
    !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8)) && !(a === 0x3fff && b <= 0x0fff);
}

export function normalizeAgentCloudEndpoint(baseUrl, operation = "chat", apiFormat = "openai", request = {}) {
  if (operation !== "chat" && operation !== "models") fail("invalid_operation", "不支持的模型请求");
  const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!raw || raw.length > 2048 || !/^https?:\/\//i.test(raw) || /[\s\\?#]/.test(raw)) {
    fail("invalid_url", "请输入不含查询参数、片段或凭据的 http(s) API 地址");
  }
  let url;
  try { url = new URL(raw); } catch { fail("invalid_url", "API 地址无效"); }
  if (url.username || url.password || raw.split("/")[2].includes("@") || /\/{2}/.test(url.pathname) || /%2f|%5c|%00/i.test(url.pathname)) {
    fail("invalid_url", "API 地址不能包含凭据或含糊路径");
  }
  const host = bareHost(url.hostname);
  const authorityHost = raw.match(/^https?:\/\/(\[[^\]]+\]|[^:/]+)/i)?.[1];
  // Reject legacy numeric IPv4 shorthand rather than quietly interpreting it as loopback.
  if (isIP(host) === 4 && authorityHost !== host) fail("invalid_url", "请使用完整 IPv4 地址");
  if (!host || host.endsWith(".") || host.includes("%")) fail("invalid_url", "API 主机名无效");
  if (url.protocol !== "https:" && !isLiteralLoopback(host)) {
    fail("https_required", "云端 API 必须使用 HTTPS；只有明确的回环 IP 可使用 HTTP");
  }
  if (isIP(host) && !isLiteralLoopback(host) && !isPublicAgentCloudAddress(host)) {
    fail("private_address", "不允许访问内网、链路本地或保留地址；本地模型请使用明确的回环 IP");
  }
  return applyAgentCloudEndpoint(url, operation, apiFormat, request);
}

function localOrigin(raw) {
  if (typeof raw !== "string" || !raw || raw === "null") return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (bareHost(url.hostname) !== "localhost" && !isLiteralLoopback(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

export function assertAgentCloudCaller(req, config = {}) {
  if (!isLoopbackPeer(req.socket?.remoteAddress)) fail("local_only", "模型代理仅允许本机请求", 403);
  const host = String(req.headers.host || "");
  const localHostOrigin = localOrigin(`http://${host}`);
  if (!localHostOrigin || /[\s/@?#\\]/.test(host)) fail("invalid_host", "请求 Host 必须是本机回环地址", 403);
  const origin = req.headers.origin;
  if (origin === undefined) {
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") fail("untrusted_origin", "不允许缺少 Origin 的跨站请求", 403);
    return; // Local CLI; no browser-derived shared credentials are kept by this service.
  }
  const parsed = localOrigin(origin);
  const origins = new Set([...(Array.isArray(config.corsOrigins) ? config.corsOrigins : []), config.publicBaseUrl, config.origin]
    .map(localOrigin).filter(Boolean));
  if (config.host && config.port) origins.add(localOrigin(`http://${config.host}:${config.port}`));
  // Actual bound gateway origin also supports randomly selected local desktop ports.
  if (host && req.socket?.localPort && Number(new URL(localHostOrigin).port || 80) === req.socket.localPort) {
    origins.add(localHostOrigin);
  }
  if (!parsed || !origins.has(parsed)) fail("untrusted_origin", "此页面来源未获模型代理授权", 403);
}

function safeString(text, apiKey) {
  let value = String(text);
  if (apiKey) value = value.split(apiKey).join("[redacted]");
  return value.replace(/Bearer\s+[^\s\"'<>]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function sanitizeValue(value, apiKey, depth = 0) {
  if (depth > 64) fail("invalid_response", "模型响应嵌套过深", 502);
  if (typeof value === "string") return safeString(value, apiKey);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, apiKey, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    result[safeString(key, apiKey)] = /^(authorization|api[_-]?key|access[_-]?token|password|secret|cookie|set-cookie)$/i.test(key)
      ? "[redacted]" : sanitizeValue(item, apiKey, depth + 1);
  }
  return result;
}

function prepareBody(body, operation) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_request", "请求必须为 JSON 对象");
  const apiFormat = parseAgentCloudFormat(body.apiFormat);
  const apiKey = body.apiKey === undefined ? "" : body.apiKey;
  if (typeof apiKey !== "string" || apiKey.length > 4096 || /[^\x20-\x7e]/.test(apiKey)) fail("invalid_key", "API Key 格式无效");
  const payload = operation === "models" ? undefined : prepareAgentCloudRequest(body.request, apiFormat);
  const endpoint = normalizeAgentCloudEndpoint(body.baseUrl, operation, apiFormat, body.request);
  const serialized = payload === undefined ? undefined : JSON.stringify(payload);
  if (serialized !== undefined && Buffer.byteLength(serialized) > REQUEST_LIMIT) fail("request_too_large", "模型请求超过大小限制", 413);
  return { endpoint, apiKey: apiKey.trim(), apiFormat, payload: serialized };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function resolveAgentCloudTargets(endpoint, lookup = dnsLookup) {
  const host = bareHost(endpoint.hostname);
  if (isIP(host)) {
    if (!isLiteralLoopback(host) && !isPublicAgentCloudAddress(host)) fail("private_address", "不允许访问非公开地址");
    return [{ address: host, family: isIP(host) }];
  }
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch { fail("dns_failed", "无法解析模型 API 主机", 502); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !isPublicAgentCloudAddress(item?.address))) {
    fail("private_address", "模型主机解析到了内网或保留地址，已拒绝");
  }
  return addresses.map(({ address }) => ({ address, family: isIP(address) }));
}

// Preserve the original single-target helper for existing internal callers.
export async function resolveAgentCloudTarget(endpoint, lookup = dnsLookup) {
  return (await resolveAgentCloudTargets(endpoint, lookup))[0];
}

function writeChunk(res, text, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (res.write(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener("drain", drained); signal.removeEventListener("abort", aborted); };
    const drained = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    res.once("drain", drained);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function publicError(error) {
  if (error instanceof AgentCloudError) return error;
  return new AgentCloudError("upstream_failed", "模型服务连接失败，请检查地址、网络和配置", 502);
}

export function createAgentCloudTransport({ lookup = dnsLookup, httpRequest = http.request, httpsRequest = https.request,
  timeoutMs = 120000, headerTimeoutMs = 15000, idleTimeoutMs = 30000, maxResponseBytes = RESPONSE_LIMIT, maxEventBytes = EVENT_LIMIT } = {}) {
  return async function transport({ endpoint, apiKey, payload, operation, signal, apiFormat = "openai" }, res) {
    const normalizer = createAgentCloudNormalizer(apiFormat);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new AgentCloudError("upstream_timeout", "模型请求超时", 504)), timeoutMs);
    let upstream;
    let outgoing;
    let headerTimer;
    try {
      const pinnedPool = await abortable(resolveAgentCloudTargets(endpoint, lookup), controller.signal);
      const pinned = pinnedPool[0];
      const multipleTargets = pinnedPool.length > 1;
      upstream = await new Promise((resolve, reject) => {
        const request = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
        const headers = { accept: operation === "models" ? "application/json" : "text/event-stream, application/json", "accept-encoding": "identity" };
        Object.assign(headers, agentCloudAuthHeaders(apiFormat, apiKey));
        if (payload !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(payload); }
        outgoing = request(endpoint, { method: operation === "models" ? "GET" : "POST", headers, agent: false,
          maxHeaderSize: 16 * 1024, signal: controller.signal, family: multipleTargets ? 0 : pinned.family,
          // Node races only TCP connections from this validated snapshot, before sending
          // the one HTTP request/body. No re-resolution or generation-level retry.
          autoSelectFamily: multipleTargets, ...(multipleTargets ? { autoSelectFamilyAttemptTimeout: 300 } : {}),
          lookup: (_host, options, callback) => typeof options === "object" && options.all
            ? callback(null, pinnedPool) : callback(null, pinned.address, pinned.family),
        }, resolve);
        outgoing.on("error", reject);
        outgoing.setTimeout(idleTimeoutMs, () => controller.abort(new AgentCloudError("upstream_timeout", "模型响应读取超时", 504)));
        headerTimer = setTimeout(() => controller.abort(new AgentCloudError("upstream_timeout", "模型响应头超时", 504)), headerTimeoutMs);
        outgoing.end(payload);
      });
      clearTimeout(headerTimer);
      const status = upstream.statusCode || 502;
      if (status < 200 || status >= 300) {
        // Do not read or include error bodies, Location, request URLs, or arbitrary error messages.
        const message = status >= 300 && status < 400 ? "模型 API 返回重定向；请填写最终 API 地址" :
          status === 401 || status === 403 ? "模型 API 认证失败，请检查 Key 和权限" :
          status === 404 ? "模型 API 路径或模型不存在" : status === 429 ? "模型 API 限流，请稍后重试" : "模型 API 请求失败";
        fail(status >= 300 && status < 400 ? "upstream_redirect" : "upstream_status", message, 502);
      }
      const mime = String(upstream.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const streaming = operation === "chat" && mime === "text/event-stream";
      if (!streaming && mime !== "application/json") fail("invalid_content_type", "模型 API 未返回 JSON 或 SSE", 502);
      if (upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity") fail("unsupported_encoding", "模型 API 返回了不支持的压缩响应", 502);
      if (Number(upstream.headers["content-length"] || 0) > maxResponseBytes) fail("response_too_large", "模型响应超过大小限制", 502);
      let size = 0;
      let buffer = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      if (streaming) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("x-accel-buffering", "no");
      }
      let emittedBytes = 0;
      const emitNormalized = async (item) => {
        const serialized = JSON.stringify(sanitizeValue(item, apiKey));
        if (Buffer.byteLength(serialized) > maxEventBytes) fail("event_too_large", "模型流事件超过大小限制", 502);
        emittedBytes += Buffer.byteLength(serialized);
        if (emittedBytes > maxResponseBytes) fail("response_too_large", "模型响应超过大小限制", 502);
        await writeChunk(res, `data: ${serialized}\n\n`, controller.signal);
      };
      const finishEvents = async () => { for (const item of normalizer.finish()) await emitNormalized(item); };
      const emitEvent = async (frame) => {
        if (Buffer.byteLength(frame) > maxEventBytes) fail("event_too_large", "模型流事件超过大小限制", 502);
        const lines = frame.replace(/\r\n|\r/g, "\n").split("\n");
        const data = lines.filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
        if (!data) return false;
        if (data.trim() === "[DONE]") { await finishEvents(); await writeChunk(res, "data: [DONE]\n\n", controller.signal); return true; }
        let item;
        try { item = JSON.parse(data); } catch { fail("invalid_response", "模型 API 返回了无效的流事件", 502); }
        if (item?.error) fail("upstream_status", "模型 API 返回了流错误", 502);
        // Validate nesting and redact before adapters retain any continuation state.
        for (const normalized of normalizer.event(sanitizeValue(item, apiKey), eventName)) await emitNormalized(normalized);
        return false;
      };
      for await (const chunk of upstream) {
        size += chunk.length;
        if (size > maxResponseBytes) fail("response_too_large", "模型响应超过大小限制", 502);
        buffer += decoder.decode(chunk, { stream: true });
        if (streaming) {
          let match;
          while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
            const event = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (await emitEvent(event)) { res.end(); return; }
          }
          if (Buffer.byteLength(buffer) > maxEventBytes) fail("event_too_large", "模型流事件超过大小限制", 502);
        }
      }
      buffer += decoder.decode();
      if (streaming) {
        const done = buffer.trim() ? await emitEvent(buffer) : false;
        if (!done) { await finishEvents(); await writeChunk(res, "data: [DONE]\n\n", controller.signal); }
        res.end();
      } else {
        let data;
        try { data = JSON.parse(buffer); } catch { fail("invalid_response", "模型 API 返回了无效 JSON", 502); }
        if (!data || typeof data !== "object" || data.error) fail("upstream_status", "模型 API 返回了错误响应", 502);
        data = sanitizeValue(data, apiKey);
        data = operation === "models" ? normalizeAgentCloudModels(data, apiFormat) : normalizer.json(data);
        const safeData = sanitizeValue(data, apiKey);
        if (Buffer.byteLength(JSON.stringify(safeData)) > maxResponseBytes) fail("response_too_large", "模型响应超过大小限制", 502);
        res.status(200).json(safeData);
      }
    } catch (error) {
      throw publicError(controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(timeout);
      clearTimeout(headerTimer);
      signal.removeEventListener("abort", abort);
      upstream?.destroy();
      outgoing?.destroy();
    }
  };
}

// Internal consumers (e.g. prompt optimization) reuse exactly the same URL guards,
// pinned transport, deadlines, normalization and redaction without an extra HTTP hop.
export async function requestAgentCloudJson(body, { signal } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.request || typeof body.request !== "object" || Array.isArray(body.request)) {
    fail("invalid_request", "缺少模型请求");
  }
  const prepared = prepareBody({ ...body, request: { ...body.request, stream: false } }, "chat");
  let result;
  const sink = {
    setHeader() {},
    status() { return this; },
    json(value) { result = value; },
    // Do not silently treat SSE from a server ignoring stream:false as JSON.
    write() { fail("invalid_response", "模型 API 未按请求返回 JSON", 502); },
    end() {},
  };
  await createAgentCloudTransport()({ ...prepared, operation: "chat", signal: signal || new AbortController().signal }, sink);
  if (result === undefined) fail("invalid_response", "模型 API 未返回 JSON", 502);
  return result;
}

export function registerAgentCloudRoutes(app, { config = {}, transport = createAgentCloudTransport() } = {}) {
  // express.json runs before these routes. Its syntax error can quote the raw body/key;
  // consume parser failures here instead of sending them to the gateway error logger.
  app.use((error, req, res, next) => {
    if (!/^\/api\/agent\/cloud\/(models|chat)\/?$/.test(req.path)) return next(error);
    const tooLarge = error?.type === "entity.too.large";
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.status(tooLarge ? 413 : 400).json({ error: {
      code: tooLarge ? "request_too_large" : "invalid_json",
      message: tooLarge ? "模型请求超过大小限制" : "模型请求 JSON 无效",
    } });
  });
  for (const operation of ["models", "chat"]) {
    app.post(`/api/agent/cloud/${operation}`, async (req, res) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(new AgentCloudError("cancelled", "请求已取消", 499)); };
      req.once("aborted", disconnected);
      res.once("close", disconnected);
      try {
        assertAgentCloudCaller(req, config);
        if (!req.is("application/json")) fail("invalid_content_type", "请求必须使用 application/json", 415);
        const prepared = prepareBody(req.body, operation);
        await transport({ ...prepared, operation, signal: controller.signal }, res);
      } catch (error) {
        if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
        const safe = publicError(error);
        const payload = { error: { code: safe.code, message: safe.message } };
        if (res.headersSent) res.end(`data: ${JSON.stringify(payload)}\n\n`);
        else res.status(safe.status).json(payload);
      } finally {
        // Do not hand raw provider exceptions or bodies to the gateway's logging error handler.
        req.removeListener("aborted", disconnected);
        res.removeListener("close", disconnected);
      }
    });
  }
}

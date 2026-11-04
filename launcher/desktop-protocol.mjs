/**
 * Desktop launcher contract (trusted parent over Node IPC, not a public API).
 * Parent -> { type: "desktop:shutdown" }; disconnect has the same owned-only effect.
 * Child  -> desktop:ready { services: { canvas, gateway, comfy: { url, mode } } },
 *           desktop:log { message, level }, desktop:error { message }.
 * Modes are adopt / started / missing. No runtime configuration is written here.
 * This is NOT a zero-write guarantee for gateway/ComfyUI: gateway startup can
 * still write its runtime data and install/update its ComfyUI bridge.
 */
import net from "node:net";
import { spawn } from "node:child_process";

export function sendDesktop(message) {
  if (typeof process.send !== "function" || !process.connected) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      process.send(message, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

export function comfySpawnEnvironment(env = process.env) {
  const result = { ...env };
  // Electron's launcher/gateway need this flag; ComfyUI Desktop must be an app.
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete result[key];
  }
  return result;
}

export function desktopLocalUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (url.protocol !== "http:" || !loopback || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Desktop 只允许本机 HTTP 根 URL（无凭据、query、hash）：${url.origin}`);
  }
  return url.origin;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
export function isDesktopGatewayHealth(value) {
  if (!object(value) || value.status !== "ok" || !object(value.comfy) ||
      typeof value.comfy.reachable !== "boolean" || typeof value.comfy.url !== "string" ||
      !object(value.tasks) || !count(value.tasks.count) ||
      !object(value.workflows) || !count(value.workflows.count)) return false;
  try {
    return ["http:", "https:"].includes(new URL(value.comfy.url).protocol);
  } catch {
    return false;
  }
}

export function isDesktopCanvasIndex(text) {
  return /<[^>]+\bid\s*=\s*["']root["']/i.test(text) &&
    /<script\b[^>]+\bsrc\s*=\s*["']\/?config\.js["']/i.test(text) &&
    /<(?:script|link)\b[^>]+\b(?:src|href)\s*=\s*["']\/assets\//i.test(text);
}

export function isDesktopCanvasConfig(text, gatewayUrl) {
  const match = text.match(/window\.__RUNTIME_CONFIG__\s*=\s*(\{[^;]*\})\s*;?\s*$/);
  if (!match) return false;
  try {
    const config = JSON.parse(match[1]);
    return object(config) && config.LOCAL_GATEWAY_URL === `${new URL(gatewayUrl).origin}/v1`;
  } catch {
    return false;
  }
}

// Identity probes never follow redirects or evaluate a returned config script.
export async function desktopGet(url, { signal, timeoutMs = 2500 } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any(signals) });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, text: "", json: null };
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error("Identity response exceeds 1 MiB");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML and config.js are text. */ }
    return { ok: true, status: response.status, text, json };
  } catch {
    return { ok: false, status: 0, text: "", json: null };
  }
}

export async function assertDesktopPortAvailable(port, session) {
  session.assertRunning();
  const server = session.ownServer(net.createServer());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    throw new Error(`网关端口 ${port} 不可用或被非网关服务占用：${error.message}`);
  });
  await new Promise((resolve) => server.close(resolve));
  session.assertRunning();
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function stopOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  // Never send /api/system/shutdown to a URL: the port may belong to somebody else.
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    if (child.exitCode === null && child.signalCode === null) child.kill();
  } else {
    // Desktop children are process-group leaders on POSIX (Comfy is detached too).
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else child.kill();
      resolve(false); // A kill request is not an observed exit.
    }, 1500);
    child.once("exit", onExit);
  });
}

export function createDesktopSession({ logger = () => {} } = {}) {
  if (typeof process.send !== "function") throw new Error("--desktop 必须通过 process.send IPC 启动");
  const controller = new AbortController();
  const servers = new Set();
  const children = new Set();
  let shutdownPromise;
  const session = {
    signal: controller.signal,
    assertRunning() {
      if (controller.signal.aborted || !process.connected) {
        const error = new Error("Desktop launcher shutdown requested");
        error.name = "AbortError";
        throw error;
      }
    },
    ownServer(server) {
      session.assertRunning();
      servers.add(server);
      server.once("close", () => servers.delete(server));
      // Covers a shutdown while a listen operation is still pending.
      server.once("listening", () => {
        if (controller.signal.aborted) void closeServer(server);
      });
      return server;
    },
    ownChild(child) {
      // No await is allowed between spawn and ownership registration.
      children.add(child);
      child.once("exit", () => children.delete(child));
      return child;
    },
    shutdown(code = 0, reason = "") {
      if (shutdownPromise) return shutdownPromise;
      controller.abort();
      shutdownPromise = (async () => {
        if (reason) logger(reason);
        await Promise.all([...servers].map(closeServer));
        const exits = await Promise.all([...children].map(stopOwnedChild));
        const confirmed = exits.every(Boolean);
        await sendDesktop({ type: "desktop:log", level: confirmed ? "INFO" : "WARN", message: confirmed
          ? "Desktop launcher 即将退出；自有服务清理已完成，外部服务未被触碰。"
          : "Desktop launcher 即将退出；已请求停止自有进程，但部分退出未获确认；外部服务未被触碰。" });
        process.exit(code);
      })();
      return shutdownPromise;
    },
  };
  // Install before configuration/probes/main: shutdown during startup is not lost.
  process.on("message", (message) => {
    if (message?.type === "desktop:shutdown") void session.shutdown(0, "收到 desktop:shutdown");
  });
  process.on("disconnect", () => void session.shutdown(0, "父进程 IPC 已断开"));
  for (const signal of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) {
    process.on(signal, () => void session.shutdown(0, `收到 ${signal}`));
  }
  return session;
}

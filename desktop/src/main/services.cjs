'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { timestampDesktopLog } = require('../renderer/log-utils.cjs');

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('桌面服务只允许不含认证信息的本机 HTTP 根地址');
  }
  return url.origin;
}

function port(value, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('服务端口必须为 1–65535');
  return result;
}

function loadSettings(root, env = process.env) {
  const file = env.DESKTOP_CONFIG_PATH || path.join(root, 'launcher/config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return {
    root,
    distribution: env.DESKTOP_DISTRIBUTION === '1',
    canvasUrl: `http://127.0.0.1:${port(env.CANVAS_PORT, config.canvasPort ?? 3000)}`,
    gatewayUrl: `http://127.0.0.1:${port(env.GATEWAY_PORT, config.gatewayPort ?? 8190)}`,
    comfyUrl: localUrl(env.COMFY_URL || config.comfyUrl || 'http://127.0.0.1:8188'),
    startupTimeoutMs: (Number(config.comfyStartTimeoutSec) || 300) * 1000
      + (Number(config.gatewayStartTimeoutSec) || 30) * 1000 + 60000,
  };
}

// Bound response size and time; do not follow a local service's redirects.
async function request(url, timeoutMs = 3500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML and runtime config are expected too. */ }
    return { text, json };
  } catch { return null; }
}

function gatewayHealth(value) {
  return value?.status === 'ok' && typeof value.comfy?.url === 'string'
    && typeof value.comfy.reachable === 'boolean' && typeof value.workflows?.count === 'number'
    && typeof value.tasks?.count === 'number';
}

function canvasConfig(text) {
  const match = text?.match(/^\s*window\.__RUNTIME_CONFIG__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) return null;
  try {
    const runtime = JSON.parse(match[1]);
    const url = new URL(runtime.LOCAL_GATEWAY_URL);
    if (url.pathname !== '/v1' && url.pathname !== '/v1/') return null;
    return localUrl(url.origin);
  } catch { return null; }
}

async function probe(settings) {
  const [health, html, config] = await Promise.all([
    request(`${settings.gatewayUrl}/health`), request(`${settings.canvasUrl}/`),
    request(`${settings.canvasUrl}/config.js`),
  ]);
  const validGateway = gatewayHealth(health?.json)
    && (!settings.distribution || health.json.desktopDistribution === true);
  const validCanvas = /id=["']root["']/.test(html?.text || '')
    && /config\.js/.test(html?.text || '') && /\/assets\//.test(html?.text || '')
    && canvasConfig(config?.text) === settings.gatewayUrl;
  let comfyUrl = settings.comfyUrl;
  if (validGateway) comfyUrl = localUrl(health.json.comfy.url);
  return {
    canvas: { url: settings.canvasUrl, mode: validCanvas ? 'adopt' : 'missing', ready: validCanvas },
    gateway: { url: settings.gatewayUrl, mode: validGateway ? 'adopt' : 'missing', ready: validGateway },
    comfy: { url: comfyUrl, mode: validGateway && health.json.comfy.reachable ? 'adopt' : 'missing',
      ready: Boolean(validGateway && health.json.comfy.reachable) },
  };
}

function validateServices(services) {
  const result = {};
  for (const key of ['canvas', 'gateway', 'comfy']) {
    const item = services?.[key];
    if (!item || !['adopt', 'started', 'missing'].includes(item.mode)) throw new Error('启动器返回了非法服务状态');
    result[key] = { url: localUrl(item.url), mode: item.mode, ready: item.mode !== 'missing' };
  }
  return result;
}

class ServiceManager extends EventEmitter {
  constructor({ root, execPath = process.execPath, env = process.env, probeServices = probe, spawnProcess = spawn } = {}) {
    super();
    this.root = root;
    this.execPath = execPath;
    this.env = { ...env };
    this.probeServices = probeServices;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.connecting = null;
    this.stopping = null;
    this.stopped = false;
    this.state = { phase: 'idle', message: '准备连接本地服务', services: null, logs: [], logsVersion: 0, ownedLauncher: false };
  }

  snapshot() { return structuredClone(this.state); }
  update(patch) { Object.assign(this.state, patch); this.emit('change', this.snapshot()); }
  log(message) {
    const text = String(message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2000);
    this.state.logs.push(timestampDesktopLog(text));
    this.state.logs = this.state.logs.slice(-100);
    this.state.logsVersion += 1;
    this.emit('change', this.snapshot());
  }

  connect({ existingOnly = false } = {}) {
    if (this.stopped) return Promise.reject(new Error('桌面端正在退出'));
    if (this.connecting) return this.connecting;
    this.connecting = this._connect(existingOnly).catch((error) => {
      if (!this.stopped) this.update({ phase: 'error', message: error.message });
      throw error;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _connect(existingOnly) {
    this.update({ phase: 'connecting', message: '正在检查画布与网关…' });
    this.settings = loadSettings(this.root, this.env);
    const configurationKey = `${this.settings.canvasUrl}|${this.settings.gatewayUrl}|${this.settings.comfyUrl}`;
    if (this.state.services && this.configurationKey === configurationKey) {
      this.settings.canvasUrl = this.state.services.canvas.url;
    }
    this.configurationKey = configurationKey;
    const services = await this.probeServices(this.settings);
    if (this.stopped) throw new Error('连接已取消');
    if (services.canvas.ready && services.gateway.ready) {
      for (const key of Object.keys(services)) {
        if (this.child && this.state.services?.[key]?.mode === 'started') services[key].mode = 'started';
      }
      this.update({ phase: services.comfy.ready ? 'ready' : 'degraded', services,
        message: services.comfy.ready ? '画布、网关和 ComfyUI 已连接' : '画布与网关可用，ComfyUI 尚未就绪' });
      return this.snapshot();
    }
    this.update({ services });
    if (existingOnly) throw new Error('现有画布或网关未就绪；只连接模式不会启动服务');
    if (this.child) throw new Error('受管服务暂不可用，请查看日志；不会重复启动或接管未知进程');
    this.update({ services, message: '正在启动缺失服务，首次启动 ComfyUI 可能需要几分钟…' });
    await this.startLauncher();
    if (this.stopped) throw new Error('连接已取消');
    const verified = await this.probeServices({ ...this.settings,
      canvasUrl: this.state.services.canvas.url, gatewayUrl: this.state.services.gateway.url });
    if (this.stopped) throw new Error('连接已取消');
    if (!verified.canvas.ready || !verified.gateway.ready) throw new Error('启动器已返回，但画布或网关健康校验未通过');
    for (const key of Object.keys(verified)) {
      if (verified[key].ready && this.state.services[key].mode === 'started') verified[key].mode = 'started';
    }
    this.update({ services: verified, phase: verified.comfy.ready ? 'ready' : 'degraded',
      message: verified.comfy.ready ? '本地创作环境已就绪' : '画布与网关已启动，请在设置中连接 ComfyUI' });
    return this.snapshot();
  }

  startLauncher() {
    const env = { ...this.env, ELECTRON_RUN_AS_NODE: '1', CLOSE_CANVAS_STOPS_BACKEND: '0', STOP_ADOPTED_COMFY: '0' };
    const child = this.spawnProcess(this.execPath, [path.join(this.root, 'launcher/start.mjs'), '--desktop', '--no-open'], {
      cwd: this.root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    this.child = child;
    this.update({ ownedLauncher: true });
    // Structured launcher log messages are the source of truth; stderr also catches import failures.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk) => this.log(chunk));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('启动超时。请查看服务日志；退出桌面端将清理受管服务。'));
      }, this.settings.startupTimeoutMs);
      const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.on('message', (message) => {
        if (message?.type === 'desktop:log') this.log(message.message);
        if (message?.type === 'desktop:error') done(new Error(message.message || '启动失败'));
        if (message?.type === 'desktop:ready' && !this.stopped) {
          try { this.update({ services: validateServices(message.services) }); done(); }
          catch (error) { done(error); }
        }
      });
      child.once('error', (error) => {
        if (!child.pid && this.child === child) {
          this.child = null;
          this.update({ ownedLauncher: false });
        }
        done(error);
      });
      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        this.update({ ownedLauncher: false });
        const error = new Error(`受管启动器已退出（${code ?? 'signal'}）`);
        done(error);
        if (!this.stopped) this.update({ phase: 'error', message: error.message });
      });
    });
  }

  async activeWork() {
    const services = this.state.services;
    if (!this.child || !services || ![services.gateway.mode, services.comfy.mode].includes('started')) return false;
    if (services.comfy.mode === 'started') {
      const queue = await request(`${services.comfy.url}/queue`);
      if (!Array.isArray(queue?.json?.queue_running) || !Array.isArray(queue?.json?.queue_pending)
        || queue.json.queue_running.length || queue.json.queue_pending.length) return true;
    }
    const response = await request(`${services.gateway.url}/api/session/status`);
    // Unknown task state is not permission to interrupt a generation.
    if (!response?.json || typeof response.json.activeTasks !== 'number') return true;
    return response.json.activeTasks > 0 || response.json.count > 0;
  }

  stop() {
    const current = this.child;
    if (this.stopped && (!current || current.exitCode !== null || current.signalCode !== null)) return Promise.resolve();
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.update({ phase: 'stopping', message: '正在清理桌面端自己启动的服务…' });
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.stopping = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        reject(new Error('启动器清理超时，未强杀任何外部服务；可再次关闭窗口重试。'));
      }, 15000);
      const onExit = () => { clearTimeout(timer); resolve(); };
      child.once('exit', onExit);
      if (child.connected) child.send({ type: 'desktop:shutdown' }, (error) => {
        if (error && child.connected) child.disconnect();
      });
      else child.kill('SIGTERM');
    }).catch((error) => { this.stopping = null; throw error; });
    return this.stopping;
  }
}

module.exports = { ServiceManager, loadSettings, localUrl, probe, request, gatewayHealth, canvasConfig, validateServices };

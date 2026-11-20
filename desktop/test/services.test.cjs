'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { ServiceManager, localUrl, probe, gatewayHealth, canvasConfig, validateServices } = require('../src/main/services.cjs');
const { isAllowedNavigation, isSessionRequest, sessionResponse } = require('../src/main/content-policy.cjs');
const root = path.resolve(__dirname, '../..');
const services = {
  canvas: { url: 'http://127.0.0.1:3000', mode: 'adopt', ready: true },
  gateway: { url: 'http://127.0.0.1:8190', mode: 'adopt', ready: true },
  comfy: { url: 'http://127.0.0.1:8188', mode: 'adopt', ready: true },
};

test('service URLs require exact local HTTP origins', () => {
  assert.equal(localUrl('http://localhost:8188/'), 'http://localhost:8188');
  for (const value of ['https://example.com', 'file:///C:/x', 'http://127.0.0.1.evil:3000',
    'http://user@127.0.0.1:3000', 'http://127.0.0.1:3000/path', 'http://127.0.0.1:3000/?x=1']) {
    assert.throws(() => localUrl(value));
  }
});

test('gateway and runtime config checks do not execute arbitrary JavaScript', () => {
  assert.equal(gatewayHealth({ status: 'ok' }), false);
  assert.equal(canvasConfig('window.__RUNTIME_CONFIG__ = {"LOCAL_GATEWAY_URL":"http://127.0.0.1:8190/v1"};'), services.gateway.url);
  assert.equal(canvasConfig('window.__RUNTIME_CONFIG__ = evil()'), null);
  assert.equal(canvasConfig('window.__RUNTIME_CONFIG__ = {"LOCAL_GATEWAY_URL":"https://example.com/v1"};'), null);
  assert.throws(() => validateServices({ ...services, canvas: { url: 'http://evil.test', mode: 'adopt' } }));
});

test('internal navigation is exact origin, not arbitrary loopback', () => {
  const origins = new Set([services.canvas.url]);
  assert.equal(isAllowedNavigation(`${services.canvas.url}/canvas/a`, origins), true);
  assert.equal(isAllowedNavigation('http://127.0.0.1:3001/', origins), false);
  assert.equal(isAllowedNavigation('file:///x', origins), false);
  assert.equal(isAllowedNavigation('http://user@127.0.0.1:3000/', origins), false);
});

test('legacy lifecycle interception acknowledges only selected gateway endpoints', async () => {
  const req = new Request(`${services.gateway.url}/api/session/close`, { method: 'POST', headers: { origin: services.canvas.url } });
  const response = sessionResponse(req, services.gateway.url, services.canvas.url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).desktop, true);
  assert.equal(response.headers.get('access-control-allow-origin'), services.canvas.url);
  assert.equal(sessionResponse(new Request(`${services.gateway.url}/health`), services.gateway.url, services.canvas.url), null);
  assert.equal(isSessionRequest('http://127.0.0.1:8191/api/session/close', services.gateway.url), false);
  assert.equal(isSessionRequest(`${services.gateway.url}/api/session/status`, services.gateway.url), false);
});

test('already running services are reused; exit never spawns or kills them', async () => {
  const manager = new ServiceManager({ root, env: {}, probeServices: async () => structuredClone(services),
    spawnProcess: () => { throw new Error('must not spawn'); } });
  const state = await manager.connect();
  assert.equal(state.phase, 'ready');
  assert.equal(state.ownedLauncher, false);
  await manager.stop();
  assert.equal(manager.child, null);
});

test('ComfyUI unavailable is a usable degraded canvas, not startup failure', async () => {
  const degraded = structuredClone(services);
  degraded.comfy = { ...degraded.comfy, mode: 'missing', ready: false };
  const manager = new ServiceManager({ root, env: {}, probeServices: async () => degraded });
  assert.equal((await manager.connect()).phase, 'degraded');
  await manager.stop();
});

test('exit while detection is pending prevents a later spawn', async () => {
  let finish;
  const manager = new ServiceManager({ root, env: {}, probeServices: () => new Promise(resolve => { finish = resolve; }),
    spawnProcess: () => { throw new Error('late spawn'); } });
  const connecting = manager.connect();
  await manager.stop();
  finish(structuredClone(services));
  await assert.rejects(connecting, /取消/);
});

test('concurrent connection uses one launcher, stop uses the private IPC channel', async () => {
  const fake = new EventEmitter();
  Object.assign(fake, { exitCode: null, signalCode: null, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter() });
  let calls = 0;
  fake.send = (message) => { assert.equal(message.type, 'desktop:shutdown'); fake.exitCode = 0; queueMicrotask(() => fake.emit('exit', 0)); };
  const missing = structuredClone(services); missing.canvas.ready = false;
  let probes = 0;
  const manager = new ServiceManager({ root, env: {}, probeServices: async () => ++probes === 1 ? missing : structuredClone(services),
    spawnProcess: (_exec, args, options) => {
      calls++;
      assert.ok(args.includes('--desktop'));
      assert.equal(options.env.STOP_ADOPTED_COMFY, '0');
      setImmediate(() => fake.emit('message', { type: 'desktop:ready', services }));
      return fake;
    } });
  const first = manager.connect();
  assert.equal(manager.connect(), first);
  await first;
  assert.equal(calls, 1);
  await manager.stop();
});

test('spawn failure releases the launcher handle so connection can be retried', async () => {
  const missing = structuredClone(services); missing.canvas.ready = false;
  let calls = 0;
  const manager = new ServiceManager({ root, env: {}, probeServices: async () => missing,
    spawnProcess: () => {
      calls++;
      const failed = new EventEmitter();
      queueMicrotask(() => failed.emit('error', new Error('spawn failed')));
      return failed;
    } });
  await assert.rejects(manager.connect(), /spawn failed/);
  assert.equal(manager.child, null);
  await assert.rejects(manager.connect(), /spawn failed/);
  assert.equal(calls, 2);
  await manager.stop();
});

test('HTTP probe rejects generic 200 HTML and wrong gateway mapping', async (t) => {
  let valid = false;
  let url;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') res.end(JSON.stringify({status:'ok',comfy:{url:'http://127.0.0.1:8188',reachable:false},tasks:{count:0},workflows:{count:0}}));
    else if (req.url === '/config.js') res.end(`window.__RUNTIME_CONFIG__ = ${JSON.stringify({LOCAL_GATEWAY_URL: url + '/v1'})};`);
    else res.end(valid ? '<div id="root"></div><script src="/config.js"></script><script src="/assets/a.js"></script>' : '<h1>Other app</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  url = `http://127.0.0.1:${server.address().port}`;
  const settings = { canvasUrl: url, gatewayUrl: url, comfyUrl: services.comfy.url };
  assert.equal((await probe(settings)).canvas.ready, false);
  valid = true;
  assert.equal((await probe(settings)).canvas.ready, true);
});

// ---- 服务面板启停：走 launcher IPC ----
// 桌面模式下 launcher 的控制端口是 0（随机），HTTP 接口拿不到，
// 所以启停只能走 process.send/on('message')。这里用一个假 child 验证协议。
function fakeLauncher({ respond = true, result = { ok: true } } = {}) {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.connected = true;
  child.sent = [];
  child.send = (message, callback) => {
    child.sent.push(message);
    if (respond) {
      // 模拟 launcher 回包：异步、且只回应匹配 requestId 的那一条。
      setImmediate(() => child.emit('message', { type: `${message.type}:result`, requestId: message.requestId, ok: true, result }));
    }
    callback?.(null);
    return true;
  };
  return child;
}

test('startService 通过 IPC 发命令并等到匹配 requestId 的回包', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  const child = fakeLauncher({ result: { ok: true, pid: 4321 } });
  manager.child = child;
  const result = await manager.startService('comfy');
  assert.deepEqual(result, { ok: true, pid: 4321 });
  assert.equal(child.sent.length, 1);
  assert.equal(child.sent[0].type, 'desktop:start-service');
  assert.equal(child.sent[0].name, 'comfy');
  assert.ok(child.sent[0].requestId);
});

test('manual Comfy start makes the service ownable by Stop even if last probe saw it missing', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  manager.state.services = {
    canvas: { url: 'http://127.0.0.1:3000', mode: 'started', ready: true },
    gateway: { url: 'http://127.0.0.1:8190', mode: 'started', ready: true },
    comfy: { url: 'http://127.0.0.1:8188', mode: 'missing', ready: false },
  };
  manager.child = fakeLauncher({ result: { ok: true, url: 'http://127.0.0.1:8188' } });
  await manager.startService('comfy');
  assert.equal(manager.state.services.comfy.mode, 'started');
  assert.equal(manager.state.services.comfy.ready, true);
  assert.deepEqual(manager.state.services.comfy.url, 'http://127.0.0.1:8188');
  assert.equal(manager.snapshot().services.comfy.mode, 'started');
});

test('a Comfy instance adopted during manual start remains non-owned and is not stoppable', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  manager.state.services = { comfy: { url: 'http://127.0.0.1:8188', mode: 'missing', ready: false } };
  manager.child = fakeLauncher({ result: { ok: true, adopted: true, url: 'http://127.0.0.1:8188' } });
  await manager.startService('comfy');
  assert.equal(manager.state.services.comfy.mode, 'missing');
  assert.equal(manager.state.services.comfy.ready, false);
});

test('stopping owned Comfy immediately resets the dashboard ready state', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  manager.state.services = { comfy: { url: 'http://127.0.0.1:8188', mode: 'started', ready: true } };
  manager.child = fakeLauncher({ result: { ok: true } });
  await manager.stopService('comfy');
  assert.equal(manager.state.services.comfy.mode, 'missing');
  assert.equal(manager.state.services.comfy.ready, false);
});

test('并发请求不会串台：回包按 requestId 对应', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.connected = true;
  child.send = (message) => { setImmediate(() => child.emit('message', { type: `${message.type}:result`, requestId: message.requestId, ok: true, result: { for: message.name } })); return true; };
  manager.child = child;
  const [a, b] = await Promise.all([manager.startService('gateway'), manager.startService('comfy')]);
  assert.deepEqual(a, { for: 'gateway' });
  assert.deepEqual(b, { for: 'comfy' });
});

test('launcher 未运行时直接报错，不发命令', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  await assert.rejects(() => manager.startService('comfy'), /受管启动器未运行/);
});

test('launcher 返回失败时把原始原因抛出来', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.connected = true;
  child.send = (message) => { setImmediate(() => child.emit('message', { type: `${message.type}:result`, requestId: message.requestId, ok: false, error: 'ComfyUI 不是本启动器启动的，无法停止' })); return true; };
  manager.child = child;
  await assert.rejects(() => manager.stopService('comfy'), /不是本启动器启动的，无法停止/);
});

test('回包超时会报错，不会永远挂着', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  manager.child = fakeLauncher({ respond: false });
  await assert.rejects(() => manager.controlLauncher('desktop:start-service', 'comfy', 60), /超时/);
});

test('启动器中途退出时立刻失败，而不是等满超时', async () => {
  const manager = new ServiceManager({ root: '/tmp', env: {}, probeServices: async () => ({}), spawnProcess: () => { throw new Error('unused'); } });
  const child = fakeLauncher({ respond: false });
  manager.child = child;
  const started = Date.now();
  const pending = manager.controlLauncher('desktop:start-service', 'comfy', 30000);
  setTimeout(() => child.emit('exit', 1), 20);
  await assert.rejects(pending, /启动器已退出/);
  assert.ok(Date.now() - started < 5000, '应在退出时立即失败');
});

test('桌面模式启动的服务必须登记到 state，否则面板会误判「不可停止」', async () => {
  // 真实 bug：桌面模式最初只把 child 交给 session.ownChild，没写进 state.gatewayChild，
  // 结果面板显示 owned=false、停止按钮禁用，点停止直接报「不是本启动器启动的」。
  const fs = require('node:fs/promises');
  const source = await fs.readFile(require('node:path').join(__dirname, '../../launcher/start.mjs'), 'utf8');
  assert.match(source, /state\.gatewayChild = child/, '桌面网关启动后必须登记到 state.gatewayChild');
  assert.match(source, /state\.comfyChild = child/, '桌面 ComfyUI 启动后必须登记到 state.comfyChild');
  assert.match(source, /state\.canvasServer = listen\.server/, '画布服务必须登记到 state.canvasServer');
});

test('接管的（adopt）外部服务不能被停止', async () => {
  // 只动自己拉起的进程：外部 ComfyUI 归用户的启动器管，我们杀掉就是事故。
  const fs = require('node:fs/promises');
  const source = await fs.readFile(require('node:path').join(__dirname, '../../launcher/start.mjs'), 'utf8');
  const stopComfy = source.slice(source.indexOf('async function stopComfyService'), source.indexOf('async function startComfyService'));
  assert.match(stopComfy, /不是本启动器启动的/, '必须在没有 comfyChild 时拒绝停止');
  const stopGateway = source.slice(source.indexOf('async function stopGatewayService'), source.indexOf('async function startGatewayService'));
  assert.match(stopGateway, /不是本启动器启动的/, '必须在没有 gatewayChild 时拒绝停止');
});

test('面板按钮规则：只有自己启动的服务才能停止，adopt 的必须禁用', async () => {
  const fs = require('node:fs/promises');
  const source = await fs.readFile(require('node:path').join(__dirname, '../src/renderer/app.js'), 'utf8');
  // 停止按钮必须依赖 mode==='started'；否则会去停用户自己的 ComfyUI。
  assert.match(source, /mode === 'started'/, 'owned 判定必须基于 mode=started');
  assert.match(source, /setServiceButtons\('comfy', \{ start: !ready\('comfy'\)/, 'ComfyUI 启动按钮应只在未就绪时可用');
  assert.match(source, /stop: owned\('comfy'\)/, 'ComfyUI 停止按钮必须要求是自己启动的');
});

test('画布与网关联动：启停任一个都同时处理两者', async () => {
  const fs = require('node:fs/promises');
  const source = await fs.readFile(require('node:path').join(__dirname, '../src/renderer/app.js'), 'utf8');
  // 网关停掉后画布无法生成，留一半没有意义。
  assert.match(source, /key === 'comfy' \? \['comfy'\] : \['gateway', 'canvas'\]/, '画布与网关必须成组操作');
  // 停止要反序（先画布后网关），避免网关没了画布还在请求。
  assert.match(source, /\[\.\.\.names\]\.reverse\(\)/, '停止顺序必须与启动相反');
});

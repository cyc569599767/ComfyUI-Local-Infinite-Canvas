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

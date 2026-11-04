// End-to-end Electron + shipped canvas + real gateway, with temporary data and a
// fake Comfy endpoint. No GPU, generation, installation, or user project writes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createGatewayApp, stopGateway } from '../../comfyui-gateway/src/server.js';
import { createCanvasServer } from '../../launcher/start.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktopDir);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-integration-'));
const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
};
const fakeComfy = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/system_stats') res.end(JSON.stringify({system:{ram_total:1024,ram_free:512},devices:[{name:'test',type:'cpu',vram_total:0,vram_free:0}]}));
  else if (req.url === '/queue') res.end('{"queue_running":[],"queue_pending":[]}');
  else if (req.url === '/') { res.setHeader('content-type','text/html'); res.end('<html><body><h1>ComfyUI test endpoint</h1></body></html>'); }
  else res.end('{}');
});
let canvas;
let gateway;
let gatewayServer;
let redirectTarget;
let redirectedRequests = 0;
try {
  const comfyUrl = await listen(fakeComfy);
  process.env.DISABLE_NODE_BOOTSTRAP = '1';
  gateway = await createGatewayApp({
    dataDir: path.join(temporary, 'data'), outputDir: path.join(temporary, 'outputs'),
    workflowDir: path.join(temporary, 'workflows'), comfyUrl, comfyDir: '', comfyWorkflowsDir: '',
    comfyFrontendDir: '', canvasDist: path.join(root, 'infinite-canvas/web/dist'),
    scanOnStart: false, watchWorkflows: false, updateEnabled: false, gatewayToken: '',
  });
  gatewayServer = http.createServer(gateway.app);
  const gatewayUrl = await listen(gatewayServer);
  redirectTarget = http.createServer((_req, res) => { redirectedRequests++; res.end('<h1>Untrusted redirect</h1>'); });
  const redirectUrl = await listen(redirectTarget);
  gateway.app.get('/desktop-test-redirect', (_req, res) => res.redirect(redirectUrl));
  // Insert this test-only route before the gateway's final 404 middleware.
  const layers = gateway.app.router.stack;
  const redirectLayer = layers.pop();
  layers.splice(layers.findIndex(layer => layer.route?.path === '/health'), 0, redirectLayer);
  gateway.app.post('/desktop-test-echo', (req, res) => res.json(req.body));
  const echoLayer = layers.pop();
  layers.splice(layers.findIndex(layer => layer.route?.path === '/health'), 0, echoLayer);
  canvas = createCanvasServer({ canvasDist: gateway.config.canvasDist, gatewayUrl,
    gatewayPort: gatewayServer.address().port, canvasHost: '127.0.0.1' });
  const canvasUrl = await listen(canvas);
  gateway.config.corsOrigins.push(canvasUrl);
  const before = gateway.sessions.status();
  const child = spawn(process.execPath, [path.join(desktopDir, 'scripts/launch.cjs'), '--integration-smoke', '--test-redirect'], {
    cwd: desktopDir, stdio: 'inherit', env: { ...process.env,
      CANVAS_PORT: String(canvas.address().port), GATEWAY_PORT: String(gatewayServer.address().port), COMFY_URL: comfyUrl },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, 'Electron integration must pass');
  assert.equal(redirectedRequests, 0, 'external navigation redirect must be rejected before fetching');
  const after = gateway.sessions.status();
  assert.equal(after.closedAt, before.closedAt, 'desktop must not submit a legacy close');
  assert.equal(after.count, 0, 'desktop must not register browser tracker sessions');
  assert.equal((await fetch(`${gatewayUrl}/health`)).status, 200, 'adopted gateway must survive');
  assert.equal((await fetch(`${comfyUrl}/system_stats`)).status, 200, 'adopted Comfy endpoint must survive');
  assert.equal((await fetch(canvasUrl)).status, 200, 'adopted canvas must survive');
  console.log('FIXTURE_INTEGRATION_OK real canvas + real gateway; no legacy session mutation; adopted services survived');
} finally {
  canvas?.closeAllConnections();
  canvas?.close();
  if (gateway) await stopGateway({ ...gateway, server: gatewayServer });
  fakeComfy.closeAllConnections();
  fakeComfy.close();
  redirectTarget?.closeAllConnections(); redirectTarget?.close();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

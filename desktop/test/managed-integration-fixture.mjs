// Real Electron -> ServiceManager -> launcher (embedded Node) -> real gateway.
// All writable runtime paths and launcher config live in a new temporary root.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktopDir);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-managed-'));
const listen = async server => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
};
const freePort = async () => {
  const server = http.createServer(); const port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
};
const fakeComfy = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/system_stats') res.end(JSON.stringify({system:{ram_total:1024,ram_free:512},devices:[{name:'test',type:'cpu',vram_total:0,vram_free:0}]}));
  else if (req.url === '/queue') res.end('{"queue_running":[],"queue_pending":[]}');
  else if (req.url === '/') { res.setHeader('content-type','text/html'); res.end('<html><body><h1>ComfyUI test endpoint</h1></body></html>'); }
  else res.end('{}');
});
try {
  const comfyPort = await listen(fakeComfy);
  const gatewayPort = await freePort();
  const canvasPort = await freePort();
  await fs.mkdir(path.join(temporary, 'launcher'));
  await fs.mkdir(path.join(temporary, 'comfy'));
  await fs.mkdir(path.join(temporary, 'workflows'));
  for (const file of ['start.mjs', 'bootstrap-nodes.mjs', 'desktop-protocol.mjs', 'desktop-comfy-bootstrap.py']) {
    await fs.copyFile(path.join(root, 'launcher', file), path.join(temporary, 'launcher', file));
  }
  await fs.writeFile(path.join(temporary, 'launcher/config.json'), JSON.stringify({
    comfyUrl: `http://127.0.0.1:${comfyPort}`, comfyDir: path.join(temporary, 'comfy'),
    comfyWorkflowsDir: path.join(temporary, 'workflows'), gatewayPort, canvasPort,
    gatewayDir: path.join(root, 'comfyui-gateway'), canvasDist: path.join(root, 'infinite-canvas/web/dist'),
    gatewayStartTimeoutSec: 15, comfyStartTimeoutSec: 2,
  }));
  const env = { ...process.env, GATEWAY_PORT: String(gatewayPort), CANVAS_PORT: String(canvasPort), COMFY_URL: `http://127.0.0.1:${comfyPort}`,
    DATA_DIR: path.join(temporary, 'data'), OUTPUT_DIR: path.join(temporary, 'output'),
    WORKFLOW_DIR: path.join(temporary, 'workflows'), SCAN_ON_START: '0', WATCH_WORKFLOWS: '0', UPDATE_ENABLED: '0',
    COMFYUI_DIR: path.join(temporary, 'comfy'), COMFY_FRONTEND_DIR: '', GATEWAY_TOKEN: '' };
  const child = spawn(process.execPath, [path.join(desktopDir, 'scripts/launch.cjs'), '--managed-integration', `--test-workspace=${temporary}`], {
    cwd: desktopDir, stdio: 'inherit', env,
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  assert.equal((await fetch(`http://127.0.0.1:${comfyPort}/system_stats`)).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${gatewayPort}/health`), /fetch failed/);
  await assert.rejects(fetch(`http://127.0.0.1:${canvasPort}/`), /fetch failed/);
  console.log('MANAGED_INTEGRATION_OK owned real gateway/canvas stopped; adopted Comfy endpoint survived');
} finally {
  fakeComfy.closeAllConnections(); fakeComfy.close();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

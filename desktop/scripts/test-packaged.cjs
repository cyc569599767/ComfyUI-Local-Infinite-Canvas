'use strict';

// Execute an unpacked installed app from an unrelated cwd, without Node on PATH
// or access to the source repository. Uses temporary config/data and mock Comfy.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DEFAULTS } = require('../src/main/application.cjs');

const PLY_FIXTURE = `ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nend_header\n0 0 0 -2.302585 -2.302585 -2.302585 1 0 0 0 0.2 0.4 0.6 2\n`;

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function freePort() { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function inventory(dir, prefix = '') {
  const result = {};
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(path.join(dir, entry.name), name));
    else if (entry.isFile()) result[name] = crypto.createHash('sha256').update(await fsp.readFile(path.join(dir, entry.name))).digest('hex');
  }
  return result;
}

(async () => {
  const desktop = path.resolve(__dirname, '..');
  const offline = process.argv.includes('--offline');
  const source = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(desktop, 'release/win-unpacked'));
  if (!fs.existsSync(path.join(source, 'ComfyCanvas.exe'))) throw new Error('先执行 npm run pack，或传入打包应用目录');
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-installed-'));
  const installed = path.join(temporary, '.build', 'Installed App');
  const userData = path.join(temporary, 'User Data');
  const comfy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/system_stats') res.end(JSON.stringify({system:{ram_total:1024,ram_free:512},devices:[{name:'fixture',type:'cpu',vram_total:0,vram_free:0}]}));
    else if (req.url === '/queue') res.end('{"queue_running":[],"queue_pending":[]}');
    else if (req.url === '/') { res.setHeader('content-type','text/html'); res.end('<html><body><h1>ComfyUI fixture</h1></body></html>'); }
    else res.end('{}');
  });
  let child;
  try {
    await fsp.cp(source, installed, { recursive: true });
    await fsp.mkdir(userData);
    const comfyPort = offline ? await freePort() : await listen(comfy);
    const usedPorts = new Set([comfyPort]);
    const nextDistinctPort = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const port = await freePort();
        if (usedPorts.has(port)) continue;
        usedPorts.add(port); return port;
      }
      throw new Error('Could not allocate distinct test service ports');
    };
    const gatewayPort = await nextDistinctPort(); const canvasPort = await nextDistinctPort();
    await fsp.writeFile(path.join(userData, 'config.json'), JSON.stringify({ ...DEFAULTS,
      comfyUrl: `http://127.0.0.1:${comfyPort}`, gatewayPort, canvasPort }));
    if (process.argv.includes('--3d')) {
      const outputs = path.join(userData, 'gateway', 'outputs'); await fsp.mkdir(outputs, { recursive: true });
      await fsp.writeFile(path.join(outputs, 'model3d_fixture.ply'), PLY_FIXTURE);
    }
    const before = await inventory(path.join(installed, 'resources'));
    const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const appArgs = process.argv.includes('--3d') ? ['--distribution-3d-smoke'] : ['--distribution-smoke'];
    child = spawn(path.join(installed, 'ComfyCanvas.exe'), [...appArgs, `--test-user-data=${userData}`], {
      cwd: temporary, env, stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged smoke exceeded 90 seconds')); }, 90000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', value => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, 'installed executable must pass its integration smoke');
    assert.deepEqual(await inventory(path.join(installed, 'resources')), before, 'application resources must remain read-only');
    assert.ok(fs.existsSync(path.join(userData, 'workflows/registry.json')));
    assert.ok(fs.existsSync(path.join(userData, 'gateway')));
    assert.ok(fs.existsSync(path.join(userData, 'logs/desktop.log')));
    if (!offline) assert.equal((await fetch(`http://127.0.0.1:${comfyPort}/system_stats`)).status, 200);
    await assert.rejects(fetch(`http://127.0.0.1:${gatewayPort}/health`));
    await assert.rejects(fetch(`http://127.0.0.1:${canvasPort}/`));
    const artifacts = path.join(desktop, 'test/artifacts', offline ? 'packaged-offline' : 'packaged');
    await fsp.mkdir(artifacts, { recursive: true });
    await fsp.cp(path.join(userData, 'test-artifacts'), artifacts, { recursive: true });
    const report = { ok: true, platform: process.platform, noExternalNode: true, relocated: true,
      applicationResourcesUnchanged: true, userDataIsolated: true, ownedServicesStopped: true, adoptedComfySurvived: offline ? null : true, offlineComfy: offline };
    await fsp.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log('PACKAGED_TEST_OK ' + JSON.stringify(report));
  } finally {
    comfy.closeAllConnections(); comfy.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

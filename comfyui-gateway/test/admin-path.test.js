import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createGatewayApp, stopGateway } from '../src/server.js';

// Production unpacked paths are not hidden, while desktop development uses
// .build/runtime. Both must serve the same explicit public file, without
// globally allowing hidden files.
test('admin and generated files work below hidden ancestor directories', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-admin-path-'));
  const originalBootstrap = process.env.DISABLE_NODE_BOOTSTRAP;
  process.env.DISABLE_NODE_BOOTSTRAP = '1';
  let gateway; let server;
  try {
    const runtime = path.join(temp, '.build', 'runtime', 'comfyui-gateway');
    const outputs = path.join(temp, '.user-data', 'outputs');
    await fs.mkdir(path.join(runtime, 'src'), { recursive: true });
    await fs.mkdir(outputs, { recursive: true });
    const admin = await fs.readFile(fileURLToPath(new URL('../src/admin.html', import.meta.url)), 'utf8');
    await fs.writeFile(path.join(runtime, 'src', 'admin.html'), admin);
    await fs.writeFile(path.join(runtime, 'src', '.secret'), 'not public');
    await fs.writeFile(path.join(outputs, 'fixture.txt'), 'generated output');
    await fs.writeFile(path.join(outputs, '.secret'), 'not public');
    gateway = await createGatewayApp({ desktopDistribution: true,
      comfyUrl: 'http://127.0.0.1:1', comfyDir: '', comfyFrontendDir: '', comfyWorkflowsDir: '',
      workflowDir: path.join(temp, 'workflows'), dataDir: path.join(temp, 'data'), outputDir: outputs,
      scanOnStart: false, watchWorkflows: false, updateEnabled: false });
    // Simulate the same rootDir resolved from an installed .build runtime.
    gateway.config.rootDir = runtime;
    server = http.createServer(gateway.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/admin`);
    assert.equal(response.status, 200, 'existing admin HTML must not be rejected due to a .build ancestor');
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(await response.text(), admin);
    assert.equal((await fetch(`${base}/admin`, { method: 'HEAD' })).status, 200);
    const output = await fetch(`${base}/files/fixture.txt`);
    assert.equal(output.status, 200);
    assert.equal(await output.text(), 'generated output');
    const originalGet = gateway.tasks.get;
    const originalContentPath = gateway.tasks.contentPath;
    try {
      gateway.tasks.get = id => id === 'fixture-video' ? { id } : null;
      gateway.tasks.contentPath = () => path.join(outputs, 'fixture.txt');
      const video = await fetch(`${base}/v1/videos/fixture-video/content`);
      assert.equal(video.status, 200);
      assert.equal(await video.text(), 'generated output');
    } finally {
      gateway.tasks.get = originalGet;
      gateway.tasks.contentPath = originalContentPath;
    }
    for (const endpoint of ['/admin/.secret', '/files/.secret', '/src/.secret']) {
      const secret = await fetch(base + endpoint);
      assert.notEqual(secret.status, 200, endpoint);
      assert.ok(!(await secret.text()).includes('not public'));
    }
  } finally {
    if (gateway) await stopGateway({ ...gateway, server });
    if (originalBootstrap === undefined) delete process.env.DISABLE_NODE_BOOTSTRAP;
    else process.env.DISABLE_NODE_BOOTSTRAP = originalBootstrap;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

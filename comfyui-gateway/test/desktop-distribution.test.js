import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createGatewayApp, stopGateway } from '../src/server.js';
import { createComfyClient } from '../src/comfy-client.js';

test('desktop distribution disables legacy update APIs and uses external user config path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-distribution-'));
  const previous = process.env.DISABLE_NODE_BOOTSTRAP;
  process.env.DISABLE_NODE_BOOTSTRAP = '1';
  let gateway; let server;
  try {
    gateway = await createGatewayApp({ desktopDistribution: true, comfyUrl: 'http://127.0.0.1:1',
      comfyDir: '', comfyWorkflowsDir: '', comfyFrontendDir: '',
      dataDir: path.join(root, 'data'), outputDir: path.join(root, 'data/outputs'), workflowDir: path.join(root, 'workflows'),
      launcherConfigPath: path.join(root, 'config.json'), scanOnStart: false, watchWorkflows: false,
      updateManifestUrl: 'http://127.0.0.1:1/must-not-fetch', updateEnabled: false });
    server = http.createServer(gateway.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const info = await fetch(`${url}/api/update/check?fetch=1`).then(r => r.json());
    assert.equal(info.updateAvailable, false); assert.equal(info.canApply, false);
    assert.equal(gateway.config.launcherConfigPath, path.join(root, 'config.json'));
    for (const endpoint of ['/api/update/apply', '/api/update/recovery/restore']) {
      const result = await fetch(url + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(result.status, 409);
      assert.equal((await result.json()).error.code, 'desktop_update_disabled');
    }
  } finally {
    if (gateway) await stopGateway({ ...gateway, server });
    if (previous === undefined) delete process.env.DISABLE_NODE_BOOTSTRAP; else process.env.DISABLE_NODE_BOOTSTRAP = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('desktop Comfy client does not discover unrelated local instances', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); throw new Error('offline'); };
  try {
    const client = createComfyClient({ baseUrl: 'http://127.0.0.1:23456', autoDiscover: false, retryAttempts: 1, retryDelayMs: 1 });
    await client.isReachable();
    assert.ok(calls.length > 0);
    assert.ok(calls.every(url => url.startsWith('http://127.0.0.1:23456/')));
  } finally { globalThis.fetch = original; }
});

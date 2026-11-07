import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createGatewayApp, stopGateway } from '../src/server.js';

test('all prompt HTTP routes forward and validate cloudTimeoutSeconds before contacting a provider', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-timeout-routes-'));
  const oldBootstrap = process.env.DISABLE_NODE_BOOTSTRAP;
  process.env.DISABLE_NODE_BOOTSTRAP = '1';
  let upstreamCalls = 0, gateway, server;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'A red cube on a desk.' } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    gateway = await createGatewayApp({ desktopDistribution: true, kvmem: { enabled: false },
      comfyUrl: 'http://127.0.0.1:1', comfyDir: '', comfyWorkflowsDir: '', comfyFrontendDir: '',
      dataDir: path.join(root, 'data'), outputDir: path.join(root, 'outputs'), workflowDir: path.join(root, 'workflows'),
      scanOnStart: false, watchWorkflows: false, updateEnabled: false,
      resourcesIndexUrl: 'http://127.0.0.1:1/no-index', resourcesIndexUrlBackup: '', resourcesFetchTimeoutMs: 10 });
    server = http.createServer(gateway.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const endpoint of ['optimize', 'optimize-image', 'caption']) {
      function form(timeout) {
        const body = new FormData();
        body.set('engine', 'cloud'); body.set('prompt', 'red cube');
        body.set('mode', endpoint === 'optimize' ? '文生视频(T2VA)' : 'text');
        body.set('cloudBaseUrl', `http://127.0.0.1:${upstream.address().port}/v1`);
        body.set('cloudApiKey', 'fixture-only'); body.set('cloudModel', 'fixture');
        body.set('cloudTimeoutSeconds', timeout);
        if (endpoint === 'caption') body.set('image', new Blob(['fixture'], { type: 'image/png' }), 'fixture.png');
        return body;
      }
      const url = `http://127.0.0.1:${server.address().port}/v1/prompts/${endpoint}`;
      const before = upstreamCalls;
      const invalid = await fetch(url, { method: 'POST', body: form('29') });
      assert.equal(invalid.status, 400, endpoint);
      assert.equal((await invalid.json()).error.code, 'cloud_invalid_timeout');
      assert.equal(upstreamCalls, before, 'invalid settings must never reach upstream');
      const valid = await fetch(url, { method: 'POST', body: form('900') });
      assert.equal(valid.status, 200, endpoint);
      assert.ok((await valid.json()).prompt);
      assert.equal(upstreamCalls, before + 1);
    }
  } finally {
    if (gateway) await stopGateway({ ...gateway, server });
    server?.closeAllConnections?.();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    if (oldBootstrap === undefined) delete process.env.DISABLE_NODE_BOOTSTRAP;
    else process.env.DISABLE_NODE_BOOTSTRAP = oldBootstrap;
    await fs.rm(root, { recursive: true, force: true });
  }
});

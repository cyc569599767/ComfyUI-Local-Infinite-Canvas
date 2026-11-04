'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication, seedWorkflows, validateConfig, DEFAULTS } = require('../src/main/application.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-app-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(root, name, text = '') { const full = path.join(root, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }

test('workflow upgrades replace unchanged defaults but preserve user edits', t => {
  const root = temporary(t); const source = path.join(root, 'source'); const target = path.join(root, 'user');
  const baseline = path.join(root, 'baseline.json');
  file(source, 'registry.json', 'original'); file(source, '_internal/tool.json', 'old');
  seedWorkflows(source, target, baseline);
  file(target, 'registry.json', 'user changed'); file(target, 'custom.json', 'custom');
  file(source, 'registry.json', 'new default'); file(source, '_internal/tool.json', 'new');
  assert.deepEqual(seedWorkflows(source, target, baseline), ['registry.json']);
  assert.equal(fs.readFileSync(path.join(target, 'registry.json'), 'utf8'), 'user changed');
  assert.equal(fs.readFileSync(path.join(target, '_internal/tool.json'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(target, 'custom.json'), 'utf8'), 'custom');
});

test('application isolates installed resources from config, data, outputs and workflows', t => {
  const root = temporary(t); const runtime = path.join(root, 'resources'); const user = path.join(root, 'user');
  for (const entry of ['launcher/start.mjs', 'comfyui-gateway/src/server.js', 'infinite-canvas/web/dist/index.html', 'runtime-manifest.json', 'comfyui-gateway/workflows/registry.json']) file(runtime, entry, '{}');
  const app = createApplication({ runtimeRoot: runtime, userData: user, env: { DATA_DIR: 'untrusted', NODE_OPTIONS: '--bad', COMFY_URL: 'http://evil' } });
  assert.equal(app.readConfig().comfyUrl, DEFAULTS.comfyUrl);
  assert.equal(app.env.OUTPUT_DIR, path.join(app.env.DATA_DIR, 'outputs'));
  assert.equal(app.env.NODE_OPTIONS, undefined);
  assert.equal(app.env.UPDATE_ENABLED, '0');
  assert.equal(app.env.ASSISTANT_ENABLED, '0');
  assert.equal(app.env.DESKTOP_CONFIG_PATH, path.join(user, 'config.json'));
  assert.equal(fs.existsSync(path.join(runtime, 'launcher/config.json')), false);
  app.saveConfig({ ...DEFAULTS, gatewayPort: 24001 });
  assert.equal(app.readConfig().gatewayPort, 24001);
});

test('configuration rejects remote URLs, port conflicts and nonexistent directories', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, comfyUrl: 'http://example.com' }));
  assert.throws(() => validateConfig({ ...DEFAULTS, gatewayPort: DEFAULTS.canvasPort }));
  assert.throws(() => validateConfig({ ...DEFAULTS, canvasPort: 80 }));
  assert.throws(() => validateConfig({ ...DEFAULTS, comfyDir: 'relative/path' }));
});

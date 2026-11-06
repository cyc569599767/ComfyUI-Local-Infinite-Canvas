'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication, seedWorkflows, validateConfig, DEFAULTS } = require('../src/main/application.cjs');
const { resolveGatewayAssetUrl } = require('../../infinite-canvas/web/src/lib/gateway-asset-url.ts');

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
  assert.ok(seedWorkflows(source, target, baseline).some(item => item.startsWith('registry.json')));
  assert.equal(fs.readFileSync(path.join(target, 'registry.json'), 'utf8'), 'user changed');
  assert.equal(fs.readFileSync(path.join(target, '_internal/tool.json'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(target, 'custom.json'), 'utf8'), 'custom');
});

test('workflow upgrade merges new upstream registry IDs while preserving existing user entries', t => {
  const root = temporary(t); const source = path.join(root, 'source'); const target = path.join(root, 'user');
  const baseline = path.join(root, 'baseline.json');
  const write = (filePath, data) => { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`); };
  write(path.join(source, 'registry.json'), { version: 1, workflows: [{ id: 'existing', label: 'updated upstream' }, { id: 'new-3d', label: '3D workflow' }] });
  write(path.join(target, 'registry.json'), { version: 1, workflows: [{ id: 'existing', label: 'user local label' }, { id: 'local-import', label: 'Local workflow' }] });
  const conflicts = seedWorkflows(source, target, baseline);
  const result = JSON.parse(fs.readFileSync(path.join(target, 'registry.json'), 'utf8'));
  assert.equal(result.workflows[0].label, 'user local label');
  assert.equal(result.workflows[1].id, 'local-import');
  assert.equal(result.workflows[2].id, 'new-3d');
  assert.ok(conflicts.some(item => item.startsWith('registry.json')));
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

test('3D gateway asset URLs follow the separate local gateway port', () => {
  const gateway = 'http://127.0.0.1:23111';
  assert.equal(resolveGatewayAssetUrl('/files/model3d_model.ply', gateway), `${gateway}/files/model3d_model.ply`);
  assert.equal(resolveGatewayAssetUrl('/files/model3d_preview.png', gateway), `${gateway}/files/model3d_preview.png`);
  assert.equal(resolveGatewayAssetUrl('/files/scene3d_depth.png', gateway), `${gateway}/files/scene3d_depth.png`);
  assert.equal(resolveGatewayAssetUrl(`${gateway}/files/model.glb`, gateway), `${gateway}/files/model.glb`);
  assert.equal(resolveGatewayAssetUrl('https://cdn.example/model.glb', gateway), 'https://cdn.example/model.glb');
  assert.equal(resolveGatewayAssetUrl('/files/model.glb', 'http://example.com'), '/files/model.glb');
});

test('configuration rejects remote URLs, port conflicts and nonexistent directories', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, comfyUrl: 'http://example.com' }));
  assert.throws(() => validateConfig({ ...DEFAULTS, gatewayPort: DEFAULTS.canvasPort }));
  assert.throws(() => validateConfig({ ...DEFAULTS, canvasPort: 80 }));
  assert.throws(() => validateConfig({ ...DEFAULTS, comfyDir: 'relative/path' }));
});

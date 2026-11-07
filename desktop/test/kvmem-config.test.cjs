'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validateConfig, createApplication } = require('../src/main/application.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-kvmem-config-'));
  // Only this exact test-owned temporary directory is removed.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const userData = path.join(root, 'user');
  for (const file of ['launcher/start.mjs', 'comfyui-gateway/src/server.js',
    'infinite-canvas/web/dist/index.html', 'runtime-manifest.json', 'comfyui-gateway/workflows/registry.json']) {
    const target = path.join(runtimeRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}');
  }
  return { root, runtimeRoot, userData };
}

const kvmemDefaults = {
  kvmemEnabled: true, kvmemInstallDir: '', kvmemModelPath: '', kvmemGpuDevice: '0', kvmemVisionMode: 'cpu',
  kvmemStartupTimeoutSec: 180, kvmemRequestTimeoutSec: 180,
};
const onlyKvmem = config => Object.fromEntries(Object.keys(kvmemDefaults).map(key => [key, config[key]]));

test('legacy configuration receives flat KVMem defaults without losing existing fields', () => {
  const legacy = { schemaVersion: 1, comfyUrl: 'http://127.0.0.1:8188', comfyDir: '', comfyWorkflowsDir: '',
    canvasPort: 24000, gatewayPort: 24001, comfyStartTimeoutSec: 200, gatewayStartTimeoutSec: 40 };
  const result = validateConfig(legacy);
  assert.deepEqual(onlyKvmem(DEFAULTS), kvmemDefaults);
  assert.deepEqual(result, { ...legacy, ...kvmemDefaults });
  assert.deepEqual(onlyKvmem(validateConfig({}, { checkDirectories: true })), kvmemDefaults);
});

test('KVMem settings require a boolean and canonical 0..15 GPU integer strings', () => {
  assert.equal(validateConfig({ kvmemEnabled: false }).kvmemEnabled, false);
  for (const value of ['true', 'false', '0', 0, 1, [], {}]) {
    assert.throws(() => validateConfig({ kvmemEnabled: value }), /kvmemEnabled/);
  }
  for (let index = 0; index <= 15; index++) {
    assert.equal(validateConfig({ kvmemGpuDevice: String(index) }).kvmemGpuDevice, String(index));
  }
  for (const value of ['', '-1', '16', '1.5', '1e0', '01', '+1', ' 0 ', '0,1', 0, 1, false, [], {}]) {
    assert.throws(() => validateConfig({ kvmemGpuDevice: value }), /kvmemGpuDevice/);
  }
});

test('KVMem vision mode is a strict enum and defaults only when absent', () => {
  assert.equal(validateConfig({}).kvmemVisionMode, 'cpu');
  assert.equal(validateConfig({ kvmemVisionMode: undefined }).kvmemVisionMode, 'cpu');
  for (const value of ['cpu', 'gpu', 'auto']) {
    assert.equal(validateConfig({ kvmemVisionMode: value }).kvmemVisionMode, value);
  }
  for (const value of [null, '', 'CPU', 'GPU', 'AUTO', ' cpu ', 'cuda', '0', 0, 1, true, false, [], ['cpu'], {}]) {
    assert.throws(() => validateConfig({ kvmemVisionMode: value }), /kvmemVisionMode/);
  }
});

test('KVMem timeouts accept integer seconds 30..600 and reject unsafe/coerced values', () => {
  for (const key of ['kvmemStartupTimeoutSec', 'kvmemRequestTimeoutSec']) {
    for (const value of [30, 180, 600]) assert.equal(validateConfig({ [key]: value })[key], value);
    for (const value of [0, 29, 601, 30.5, NaN, Infinity, '180', '', true, [], {}]) {
      assert.throws(() => validateConfig({ [key]: value }), new RegExp(key));
    }
  }
});

test('KVMem paths may be empty or absolute without installed binaries; models must be .ninfer', () => {
  const installation = path.resolve('test-only-uninstalled-kvmem');
  const model = path.join(installation, 'model.NINFER');
  const result = validateConfig({ kvmemInstallDir: ` ${installation} `, kvmemModelPath: model }, { checkDirectories: true });
  assert.equal(result.kvmemInstallDir, installation);
  assert.equal(result.kvmemModelPath, model);
  for (const key of ['kvmemInstallDir', 'kvmemModelPath']) {
    assert.equal(validateConfig({ [key]: '  ' }, { checkDirectories: true })[key], '');
    for (const value of ['relative/model.ninfer', `bad\0path`, 1, false, [], {}]) {
      assert.throws(() => validateConfig({ [key]: value }), new RegExp(key));
    }
  }
  for (const name of ['model.gguf', 'model.ninfer.exe', 'model', 'model.ninfer/child']) {
    assert.throws(() => validateConfig({ kvmemModelPath: path.join(installation, name) }), /\.ninfer/);
  }
});

test('application starts with empty KVMem paths and clears every inherited KVMEM_* setting', t => {
  const f = fixture(t);
  const inherited = { SAFE_MARKER: 'retained', KVMEM_ENABLED: '0', KVMEM_INSTALL_DIR: 'untrusted',
    KVMEM_MODEL_PATH: 'untrusted', KVMEM_GPU_DEVICE: '15', KVMEM_VISION_MODE: 'gpu', KVMEM_STARTUP_TIMEOUT_MS: '1',
    KVMEM_REQUEST_TIMEOUT_MS: '2', KVMEM_SERVER_URL: 'http://untrusted', KVMEM_FUTURE_FLAG: 'unsafe',
    kVmEm_Enabled: '0', kvmem_vision_mode: 'auto', kvmem_unknown_option: 'unsafe' };
  const application = createApplication({ ...f, env: inherited });
  assert.deepEqual(onlyKvmem(application.readConfig()), kvmemDefaults);
  assert.deepEqual(Object.fromEntries(Object.entries(application.env).filter(([key]) => /^KVMEM_/i.test(key))), {
    KVMEM_ENABLED: '1', KVMEM_INSTALL_DIR: '', KVMEM_MODEL_PATH: '', KVMEM_GPU_DEVICE: '0', KVMEM_VISION_MODE: 'cpu',
    KVMEM_STARTUP_TIMEOUT_MS: '180000', KVMEM_REQUEST_TIMEOUT_MS: '180000',
  });
  assert.equal(application.env.SAFE_MARKER, 'retained');
  assert.equal(inherited.KVMEM_FUTURE_FLAG, 'unsafe', 'caller environment must not be mutated');
  assert.equal(inherited.kVmEm_Enabled, '0');
  assert.equal(inherited.KVMEM_VISION_MODE, 'gpu');
  assert.equal(inherited.kvmem_vision_mode, 'auto');
  assert.deepEqual(onlyKvmem(application.saveConfig({ ...DEFAULTS })), kvmemDefaults);
});

test('saved KVMem settings persist, preserve legacy fields and reach only the next launch environment', t => {
  const f = fixture(t);
  const app = createApplication({ ...f, env: {} });
  const next = { ...DEFAULTS, canvasPort: 24000, gatewayPort: 24001, comfyStartTimeoutSec: 500,
    gatewayStartTimeoutSec: 45, kvmemEnabled: false, kvmemInstallDir: path.join(f.root, 'not-installed'),
    kvmemModelPath: path.join(f.root, 'not-downloaded.ninfer'), kvmemGpuDevice: '15', kvmemVisionMode: 'gpu',
    kvmemStartupTimeoutSec: 30, kvmemRequestTimeoutSec: 600 };
  assert.deepEqual(app.saveConfig(next), next);
  assert.deepEqual(app.readConfig(), next);
  assert.equal(app.env.KVMEM_ENABLED, '1', 'saving must not reconfigure or restart a running service');
  assert.equal(app.env.KVMEM_VISION_MODE, 'cpu');
  const restarted = createApplication({ ...f, env: {} });
  assert.equal(restarted.env.KVMEM_ENABLED, '0');
  assert.equal(restarted.env.KVMEM_INSTALL_DIR, next.kvmemInstallDir);
  assert.equal(restarted.env.KVMEM_MODEL_PATH, next.kvmemModelPath);
  assert.equal(restarted.env.KVMEM_GPU_DEVICE, '15');
  assert.equal(restarted.env.KVMEM_VISION_MODE, 'gpu');
  assert.equal(restarted.env.KVMEM_STARTUP_TIMEOUT_MS, '30000');
  assert.equal(restarted.env.KVMEM_REQUEST_TIMEOUT_MS, '600000');
  const before = fs.readFileSync(app.configFile, 'utf8');
  assert.throws(() => app.saveConfig({ ...next, kvmemGpuDevice: '16' }), /kvmemGpuDevice/);
  assert.throws(() => app.saveConfig({ ...next, kvmemVisionMode: 'GPU' }), /kvmemVisionMode/);
  assert.equal(fs.readFileSync(app.configFile, 'utf8'), before);
});

test('every saved vision mode overrides inherited environment on the next launch', t => {
  const f = fixture(t);
  const app = createApplication({ ...f, env: {} });
  for (const mode of ['cpu', 'gpu', 'auto']) {
    app.saveConfig({ ...DEFAULTS, kvmemVisionMode: mode });
    const restarted = createApplication({ ...f, env: { KVMEM_VISION_MODE: 'unsafe', kVmEm_ViSiOn_MoDe: 'gpu' } });
    assert.equal(restarted.readConfig().kvmemVisionMode, mode);
    assert.equal(restarted.env.KVMEM_VISION_MODE, mode);
    assert.equal(restarted.env.kVmEm_ViSiOn_MoDe, undefined);
  }
});

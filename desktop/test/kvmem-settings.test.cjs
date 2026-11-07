'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedSender } = require('../src/main/runtime.cjs');

const rendererRoot = path.join(__dirname, '../src/renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');
const legacyConfig = { comfyUrl: 'http://127.0.0.1:8188', comfyDir: '', canvasPort: 23110, gatewayPort: 23111 };

function element() {
  const handlers = new Map();
  return { value: '', checked: false, disabled: false, hidden: false, textContent: '', dataset: {},
    classList: { toggle() {} }, addEventListener(type, handler) { handlers.set(type, handler); },
    fire(type) { return handlers.get(type)?.({ preventDefault() {} }); } };
}
async function rendererFixture({ config = legacyConfig, picker } = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element()]));
  const document = { getElementById: id => elements.get(id), querySelectorAll: () => [], documentElement: { dataset: {} } };
  const saves = []; const choices = []; const calls = [];
  const desktop = { onState() {}, getRuntimeInfo: async () => ({ electron: 'fixture', development: false }),
    getState: async () => ({ phase: 'idle', activePage: 'dashboard', logs: [] }),
    getConfig: async () => config ? { config, userData: 'test-only' } : null,
    saveConfig: async value => { saves.push(value); }, chooseComfy: async () => '',
    restart: async () => calls.push('restart'), connect: async () => calls.push('connect'),
    refresh: async () => {}, reloadPage: async () => {}, openDevTools: async () => {}, openData: async () => {} };
  if (picker) desktop.chooseKvmem = async kind => { choices.push(kind); return picker(kind); };
  vm.runInNewContext(rendererSource, { document, window: { desktop, addEventListener() {},
    DesktopLogView: { createLogView: () => ({ refresh() {}, dispose() {}, update() {} }) } } }, { filename: 'app.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.documentElement.dataset.ready, 'true');
  return { get: id => elements.get(id), saves, choices, calls, document };
}

test('legacy renderer fixtures without chooseKvmem initialize and save without automatic picker calls', async () => {
  const f = await rendererFixture();
  assert.equal(f.get('setting-kvmem-enabled').checked, true);
  assert.equal(f.get('setting-kvmem-install-dir').value, '');
  assert.equal(f.get('setting-kvmem-model-path').value, '');
  assert.equal(f.get('setting-kvmem-gpu-device').value, '0');
  assert.equal(f.get('setting-kvmem-vision-mode').value, 'cpu');
  for (const id of ['choose-kvmem-install-dir', 'choose-kvmem-model-path']) {
    assert.equal(f.get(id).disabled, true);
    await f.get(id).fire('click'); // Even a synthetic event must not call an absent method.
  }
  await f.get('settings-form').fire('submit');
  assert.match(f.get('settings-result').textContent, /已保存.*重启/);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].kvmemEnabled, true);
  assert.equal(f.saves[0].kvmemVisionMode, 'cpu');
  assert.equal(f.saves[0].comfyUrl, legacyConfig.comfyUrl);
  assert.equal(f.saves[0].gatewayPort, legacyConfig.gatewayPort);
  assert.deepEqual(f.calls, []);
});

test('KVMem picker runs only on explicit click; cancel preserves paths and clear remains savable', async () => {
  const installDir = path.resolve('test-only-kvmem');
  const modelPath = path.join(installDir, 'test-only.ninfer');
  let canceled = false;
  const f = await rendererFixture({ picker: kind => canceled ? null : kind === 'installDir' ? installDir : modelPath });
  assert.deepEqual(f.choices, []);
  assert.equal(f.get('choose-kvmem-install-dir').disabled, false);
  await f.get('choose-kvmem-install-dir').fire('click');
  await f.get('choose-kvmem-model-path').fire('click');
  assert.deepEqual(f.choices, ['installDir', 'modelPath']);
  assert.equal(f.get('setting-kvmem-install-dir').value, installDir);
  assert.equal(f.get('setting-kvmem-model-path').value, modelPath);
  canceled = true;
  await f.get('choose-kvmem-install-dir').fire('click');
  await f.get('choose-kvmem-model-path').fire('click');
  assert.equal(f.get('setting-kvmem-install-dir').value, installDir);
  assert.equal(f.get('setting-kvmem-model-path').value, modelPath);
  await f.get('clear-kvmem-install-dir').fire('click');
  await f.get('clear-kvmem-model-path').fire('click');
  await f.get('settings-form').fire('submit');
  assert.equal(f.saves[0].kvmemInstallDir, '');
  assert.equal(f.saves[0].kvmemModelPath, '');
  assert.equal(f.choices.length, 4, 'save must not open a picker');
  assert.deepEqual(f.calls, [], 'save must not auto-restart or connect services');
});

test('renderer restores disabled KVMem and saves visible fields while preserving hidden timeout/legacy settings', async () => {
  const config = { ...legacyConfig, comfyWorkflowsDir: path.resolve('test-workflows'), comfyStartTimeoutSec: 400,
    gatewayStartTimeoutSec: 50, kvmemEnabled: false, kvmemInstallDir: path.resolve('test-kvmem'),
    kvmemModelPath: path.resolve('test-model.ninfer'), kvmemGpuDevice: '14', kvmemVisionMode: 'gpu',
    kvmemStartupTimeoutSec: 60, kvmemRequestTimeoutSec: 600 };
  const f = await rendererFixture({ config });
  assert.equal(f.get('setting-kvmem-enabled').checked, false);
  assert.equal(f.get('setting-kvmem-install-dir').value, config.kvmemInstallDir);
  assert.equal(f.get('setting-kvmem-model-path').value, config.kvmemModelPath);
  assert.equal(f.get('setting-kvmem-gpu-device').value, '14');
  assert.equal(f.get('setting-kvmem-vision-mode').value, 'gpu');
  f.get('setting-kvmem-enabled').checked = true;
  f.get('setting-kvmem-gpu-device').value = '15';
  f.get('setting-kvmem-vision-mode').value = 'auto';
  await f.get('settings-form').fire('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(f.saves[0])), { ...config, kvmemEnabled: true, kvmemGpuDevice: '15', kvmemVisionMode: 'auto' });
});

test('renderer restores and saves each supported vision mode without starting a service', async () => {
  for (const mode of ['cpu', 'gpu', 'auto']) {
    const f = await rendererFixture({ config: { ...legacyConfig, kvmemVisionMode: mode } });
    assert.equal(f.get('setting-kvmem-vision-mode').value, mode);
    await f.get('settings-form').fire('submit');
    assert.equal(f.saves[0].kvmemVisionMode, mode);
    assert.deepEqual(f.calls, []);
  }
});

test('settings-disabled test mode does not save or open KVMem pickers at startup', async () => {
  const f = await rendererFixture({ config: null, picker: () => assert.fail('unexpected picker') });
  assert.equal(f.get('settings-panel').hidden, true);
  await f.get('settings-form').fire('submit');
  assert.equal(f.saves.length, 0);
  assert.match(f.get('settings-result').textContent, /不支持设置/);
});

test('KVMem HTML offers CPU/GPU/auto vision modes with CPU selected by default', () => {
  const select = html.match(/<select\b[^>]*id="setting-kvmem-vision-mode"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'vision mode select must exist');
  const options = [...select[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
  assert.deepEqual(options.map(option => option[1].match(/value="([^"]+)"/)[1]), ['cpu', 'gpu', 'auto']);
  assert.match(options[0][1], /\bselected\b/);
  assert.ok(options.slice(1).every(option => !/\bselected\b/.test(option[1])));
  assert.match(options[0][2], /CPU.*省显存.*默认/);
  assert.match(options[1][2], /GPU.*更高显存/);
  assert.match(options[2][2], /自动.*空闲显存/);
});

test('KVMem HTML paths use readonly native pickers and describe lifecycle/availability constraints', () => {
  for (const id of ['setting-kvmem-install-dir', 'setting-kvmem-model-path']) {
    assert.match(html, new RegExp(`<input[^>]+id="${id}"[^>]+readonly`));
  }
  for (const text of ['本地反推使用KVMem（结束后释放显存）', '.ninfer', '替代旧本地反推策略', '不捆绑程序或模型',
    'CPU 模式仅将视觉编码放在 CPU', '主模型仍使用 CUDA', '保守容量判断', '不代表必然加速', '不保证不会 OOM',
    '不影响应用启动', '首次加载较慢', '视频任务忙时拒绝反推', '每次反推结束后退出自有进程释放显存',
    '不停止外部进程', '保存后重启应用生效']) {
    assert.ok(html.includes(text), text);
  }
});

// Load main code with inert Electron/services stubs. No Electron process,
// lifecycle callback, real native dialog or user configuration is started/read.
function ipcFixture() {
  const handlers = new Map(); const dialogs = []; const saves = [];
  let result = { canceled: false, filePaths: [path.resolve('test-only-selection')] };
  const mainRoot = path.join(__dirname, '../src/main');
  const rendererUrl = pathToFileURL(path.join(rendererRoot, 'index.html')).href;
  const webContents = { mainFrame: { url: rendererUrl } };
  const mainWindow = { webContents, isDestroyed: () => false };
  const app = { isPackaged: false, requestSingleInstanceLock: () => true, on() {},
    whenReady: () => ({ then: () => ({ catch() {} }) }) };
  const electron = { app, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (window, options) => { dialogs.push({ window, options }); return result; } } };
  const context = vm.createContext({ __dirname: mainRoot, process: { argv: ['node', 'unit-test'] }, console,
    require: name => {
      if (name === 'electron') return electron;
      if (name === './runtime.cjs') return { isTrustedSender };
      if (name === './services.cjs') return { ServiceManager: class { on() {} } };
      if (name === './response-headers.cjs') return require('../src/main/response-headers.cjs');
      if (name === './application.cjs' || name === './content-policy.cjs') return {};
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected test dependency: ${name}`);
    }, fixtureWindow: mainWindow, fixtureApplication: { saveConfig: value => saves.push(value) } });
  vm.runInContext(fs.readFileSync(path.join(mainRoot, 'index.cjs'), 'utf8'), context, { filename: 'index.cjs' });
  vm.runInContext('mainWindow = fixtureWindow; application = fixtureApplication; registerIPC();', context);
  return { handlers, dialogs, saves, mainWindow, event: { sender: webContents, senderFrame: webContents.mainFrame },
    setResult: value => { result = value; } };
}

test('KVMem native picker IPC restricts path kind and opens only the expected dialog', async () => {
  const f = ipcFixture();
  const pick = f.handlers.get('app:choose-kvmem');
  const selected = await pick(f.event, 'installDir');
  assert.equal(selected, path.resolve('test-only-selection'));
  assert.equal(f.dialogs[0].window, f.mainWindow);
  assert.equal(f.dialogs[0].options.title, 'KVMem安装目录');
  assert.deepEqual([...f.dialogs[0].options.properties], ['openDirectory']);
  await pick(f.event, 'modelPath');
  assert.deepEqual([...f.dialogs[1].options.properties], ['openFile']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.dialogs[1].options.filters)), [{ name: 'KVMem 模型', extensions: ['ninfer'] }]);
  for (const kind of [undefined, '', 'binaryPath', '../modelPath', {}]) await assert.rejects(pick(f.event, kind), /未知 KVMem/);
  assert.equal(f.dialogs.length, 2);
  f.setResult({ canceled: true, filePaths: ['ignored'] });
  assert.equal(await pick(f.event, 'installDir'), null);
  f.setResult({ canceled: false, filePaths: [] });
  assert.equal(await pick(f.event, 'modelPath'), null);
  assert.deepEqual(f.saves, [], 'selection alone must not save configuration');
});

test('KVMem picker and config writes retain trusted-main-frame IPC enforcement', async () => {
  const f = ipcFixture();
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.event.senderFrame.url } },
    { ...f.event, senderFrame: { url: 'http://127.0.0.1:23110/' } }, { ...f.event, senderFrame: null }]) {
    assert.throws(() => f.handlers.get('app:choose-kvmem')(event, 'installDir'), /Untrusted IPC sender/);
    assert.throws(() => f.handlers.get('app:save-config')(event, { kvmemInstallDir: 'unsafe' }), /Untrusted IPC sender/);
  }
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.saves, []);
  const value = { kvmemInstallDir: path.resolve('trusted-native-setting') };
  const saved = f.handlers.get('app:save-config')(f.event, value);
  assert.equal(saved.restartRequired, true);
  assert.deepEqual(f.saves, [value]);
});

test('preload exposes a narrow KVMem selection method and does not invoke it at load time', async () => {
  let api; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload/index.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktop'); api = value; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return 'selected'; } } };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(await api.chooseKvmem('installDir'), 'selected');
  assert.equal(await api.chooseKvmem('modelPath'), 'selected');
  assert.deepEqual(calls, [['app:choose-kvmem', 'installDir'], ['app:choose-kvmem', 'modelPath']]);
  assert.equal(api.invoke, undefined);
});

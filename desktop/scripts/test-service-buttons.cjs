'use strict';
// 服务面板按钮状态验证：真实渲染 + 真实点击，覆盖「perform 之后按钮是否恢复」。
//
// 注意：本脚本必须以真实 Electron 运行（需要 app/BrowserWindow）。
// 如果环境里带了 ELECTRON_RUN_AS_NODE=1（打包/CI 常见），Electron 会退化成
// 纯 Node 模式，requiring 'electron' 得到的是路径字符串而不是 API。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('请清除 ELECTRON_RUN_AS_NODE 后再运行：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test-service-buttons.cjs');
  process.exit(2);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'service-buttons-'));
const preload = path.join(temp, 'preload.cjs');

// canvas/gateway 由桌面端启动（可停），comfy 是复用（不可停）—— 正好覆盖两条分支。
const initialState = {
  phase: 'ready', activePage: 'dashboard', message: '本地创作环境已就绪',
  services: {
    canvas: { url: 'http://127.0.0.1:23110', ready: true, mode: 'started' },
    gateway: { url: 'http://127.0.0.1:23111', ready: true, mode: 'started' },
    comfy: { url: 'http://127.0.0.1:8188', ready: true, mode: 'adopt' },
  },
  logs: [], logsVersion: 0,
};

fs.writeFileSync(preload, `
const { contextBridge } = require('electron');
const state = ${JSON.stringify(initialState)};
contextBridge.exposeInMainWorld('desktop', {
  getRuntimeInfo: async () => ({ electron: '41', node: '24', chrome: '146', version: 'x', platform: 'win32', development: false }),
  getState: async () => state,
  getConfig: async () => null,
  onState: () => () => {},
  // 关键：这些操作会走 perform()，也就是会把 busy 置真再复位。
  connect: async () => state,
  refresh: async () => state,
  startService: async () => state,
  stopService: async () => state,
  reloadPage: async () => {}, openDevTools: async () => {}, showPage: async () => {},
  saveConfig: async () => {}, chooseComfy: async () => '', openData: async () => {}, restart: async () => {},
});
`);

const read = (win) => win.webContents.executeJavaScript(`(() => {
  const g = (id) => { const b = document.getElementById(id); return { disabled: b.disabled, title: b.title }; };
  return {
    canvasStart: g('canvas-start'), canvasStop: g('canvas-stop'),
    gatewayStart: g('gateway-start'), gatewayStop: g('gateway-stop'),
    comfyStart: g('comfy-start'), comfyStop: g('comfy-stop'),
  };
})()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(root, 'src/renderer/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const until = Date.now() + 5000;
    while (document.documentElement.dataset.ready !== 'true') {
      if (Date.now() > until) throw new Error('renderer not ready');
      await new Promise(r => setTimeout(r, 20));
    }
  })()`);

  const initial = await read(win);
  // 已就绪：启动禁用、停止可用（canvas/gateway 是我们启动的）。
  assert.equal(initial.canvasStart.disabled, true, '已运行的画布不该可启动');
  assert.equal(initial.canvasStop.disabled, false, '自己启动的画布必须可停止');
  assert.equal(initial.gatewayStop.disabled, false, '自己启动的网关必须可停止');
  // adopt 的 ComfyUI：两个都禁用。
  assert.equal(initial.comfyStart.disabled, true, '复用中的 ComfyUI 不该可启动');
  assert.equal(initial.comfyStop.disabled, true, '复用中的 ComfyUI 不该可停止');

  // 关键回归：点一次「检查状态」走 perform()，按钮必须恢复。
  // 旧实现只在 finally 里改 connect/refresh，服务按钮会永久卡在禁用。
  await win.webContents.executeJavaScript(`document.getElementById('refresh').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterRefresh = await read(win);
  assert.equal(afterRefresh.canvasStop.disabled, false, 'perform 之后停止按钮不能卡在禁用');
  assert.equal(afterRefresh.gatewayStop.disabled, false, 'perform 之后网关停止按钮不能卡在禁用');
  assert.equal(afterRefresh.canvasStart.disabled, true, '已在运行不该可启动');

  // 点一次「停止」也要能回到正确状态（这里 mock 不真的改状态）。
  await win.webContents.executeJavaScript(`document.getElementById('canvas-stop').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterStop = await read(win);
  assert.equal(afterStop.canvasStop.disabled, false, '停止操作完成后按钮要恢复可用');

  console.log('SERVICE_BUTTONS_OK ' + JSON.stringify({ initial, afterRefresh, afterStop }));
  win.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
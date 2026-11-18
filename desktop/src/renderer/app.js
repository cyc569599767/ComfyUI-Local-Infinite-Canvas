'use strict';

const $ = (id) => document.getElementById(id);
let busy = false;
// 服务启停自己的忙碌标记，按「画布+网关联动组」和「ComfyUI」分别记录。
// 与全局 busy 分开：连接类操作卡住时不该连带把启停按钮永久禁掉。
const serviceBusy = new Set();
let state = null;
let config = null;
const logView = window.DesktopLogView.createLogView({
  element: $('logs'), followToggle: $('logs-follow'), latestButton: $('logs-latest'),
  status: $('logs-follow-status'), details: $('logs-panel'),
});
window.addEventListener('resize', () => logView.refresh());
window.addEventListener('pagehide', () => logView.dispose(), { once: true });

function render(next) {
  const previousPage = state?.activePage;
  state = next;
  const pending = busy || ['connecting', 'stopping'].includes(state.phase);
  $('connection-message').textContent = state.message;
  $('connect').disabled = pending;
  $('refresh').disabled = pending;
  const labels = { ready: '服务已连接', degraded: '部分服务待连接', error: '连接遇到问题', connecting: '正在连接…', stopping: '正在退出…', idle: '等待连接' };
  $('status').textContent = labels[state.phase] || state.phase;
  for (const key of ['canvas', 'gateway', 'comfy']) {
    const service = state.services?.[key];
    $(`${key}-status`).textContent = service?.ready ? '已就绪' : '未就绪';
    $(`${key}-status`).className = service?.ready ? 'online' : '';
    $(`${key}-url`).textContent = service?.url || '—';
    $(`${key}-owner`).textContent = service?.mode === 'started' ? '由桌面端启动 · 退出时清理'
      : service?.mode === 'adopt' ? '复用现有服务 · 退出时不主动停止' : '服务不可用';
  }
  // 画布与网关绑在一起：网关停止后画布也用不了，单独留一个没有意义。
  // 复用（adopt）的服务不是我们拉起的，启停按钮必须禁用，避免误杀用户自己的进程。
  // 注意：服务按钮只看「是否自己启动」和「自己这次操作是否在跑」，
  // 不看全局 busy——否则一次卡住的连接请求会让所有启停按钮永久变灰。
  const owned = (key) => state.services?.[key]?.mode === 'started';
  const ready = (key) => Boolean(state.services?.[key]?.ready);
  const busyKey = (key) => serviceBusy.has(key === 'comfy' ? 'comfy' : 'canvas-group');
  const canvasGroupOwned = owned('canvas') || owned('gateway');
  const canvasGroupReady = ready('canvas') && ready('gateway');
  const canvasBusy = busyKey('canvas');
  setServiceButtons('canvas', { start: !canvasGroupReady && !canvasBusy, stop: canvasGroupOwned && !canvasBusy });
  setServiceButtons('gateway', { start: !canvasGroupReady && !canvasBusy, stop: canvasGroupOwned && !canvasBusy });
  setServiceButtons('comfy', { start: !ready('comfy') && !busyKey('comfy'), stop: owned('comfy') && !busyKey('comfy') });
  for (const button of document.querySelectorAll('[data-page]')) {
    button.disabled = button.dataset.page !== 'dashboard' && !state.services?.[button.dataset.page]?.ready;
    button.classList.toggle('active', button.dataset.page === (state.activePage || 'dashboard'));
  }
  logView.update(state.logs, state.logsVersion);
  if (state.activePage === 'dashboard' && previousPage !== 'dashboard') logView.refresh();
}

function setServiceButtons(key, { start, stop }) {
  $(`${key}-start`).disabled = !start;
  $(`${key}-stop`).disabled = !stop;
  $(`${key}-start`).title = start ? `启动${serviceLabel(key)}` : `${serviceLabel(key)}已在运行`;
  $(`${key}-stop`).title = stop ? `停止${serviceLabel(key)}` : '该服务不是桌面端启动的，无法停止';
}

function serviceLabel(key) {
  return { canvas: '无限画布与网关', gateway: '无限画布与网关', comfy: 'ComfyUI' }[key] || key;
}

async function perform(action) {
  busy = true;
  if (state) render(state);
  try { await action(); }
  catch (error) { $('connection-message').textContent = error.message; }
  finally {
    busy = false;
    // 必须重绘：render 会按 pending 禁用一批控件，只手动恢复 connect/refresh
    // 会让其余按钮停在禁用态（服务启停按钮就是这么被卡住的）。
    if (state) render(state);
  }
}

window.desktop.onState(render);
$('connect').addEventListener('click', () => perform(() => window.desktop.connect()));
$('refresh').addEventListener('click', () => perform(() => window.desktop.refresh()));
$('reload').addEventListener('click', () => perform(() => window.desktop.reloadPage()));
$('devtools').addEventListener('click', () => perform(() => window.desktop.openDevTools()));
for (const button of document.querySelectorAll('[data-page]')) {
  button.addEventListener('click', () => perform(() => window.desktop.showPage(button.dataset.page)));
}
// 服务启停。画布与网关是一个整体：启停任一都同时处理两者，
// 否则会出现「网关停了但画布还开着」的半死状态。
// 用独立的 serviceBusy 而不是全局 busy：连接类操作卡住时不应连带禁掉启停按钮。
for (const key of ['canvas', 'gateway', 'comfy']) {
  for (const action of ['start', 'stop']) {
    $(`${key}-${action}`).addEventListener('click', async () => {
      const groupKey = key === 'comfy' ? 'comfy' : 'canvas-group';
      if (serviceBusy.has(groupKey)) return;
      const names = key === 'comfy' ? ['comfy'] : ['gateway', 'canvas'];
      const method = action === 'start' ? 'startService' : 'stopService';
      // 停止要反序：先停画布再停网关，避免网关没了画布还在请求。
      const ordered = action === 'start' ? names : [...names].reverse();
      serviceBusy.add(groupKey);
      if (state) render(state);
      try {
        const errors = [];
        for (const name of ordered) {
          try { await window.desktop[method](name); }
          catch (error) { errors.push(`${name}: ${error.message}`); }
        }
        if (errors.length) throw new Error(errors.join('；'));
      } catch (error) {
        $('connection-message').textContent = error.message;
      } finally {
        serviceBusy.delete(groupKey);
        // 必须在 finally 里重绘：否则按钮会停在操作中的禁用状态。
        if (state) render(state);
      }
    });
  }
}
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (!config) throw new Error('当前模式不支持设置');
    await window.desktop.saveConfig({ ...config, comfyUrl: $('setting-comfy-url').value,
      comfyDir: $('setting-comfy-dir').value, canvasPort: Number($('setting-canvas-port').value),
      gatewayPort: Number($('setting-gateway-port').value) });
    $('settings-result').textContent = '已保存。完成当前生成后点击「重启应用」生效。';
  } catch (error) { $('settings-result').textContent = error.message; }
});
$('choose-comfy').addEventListener('click', () => perform(async () => {
  const selected = await window.desktop.chooseComfy();
  if (selected) $('setting-comfy-dir').value = selected;
}));
$('open-data').addEventListener('click', () => perform(() => window.desktop.openData()));
$('restart-app').addEventListener('click', () => perform(() => window.desktop.restart()));
(async () => {
  try {
    const [info, initial, settings] = await Promise.all([window.desktop.getRuntimeInfo(), window.desktop.getState(), window.desktop.getConfig()]);
    $('devtools').hidden = !info.development;
    $('settings-panel').hidden = !settings;
    if (settings) {
      config = settings.config;
      $('setting-comfy-url').value = config.comfyUrl;
      $('setting-comfy-dir').value = config.comfyDir;
      $('setting-canvas-port').value = config.canvasPort;
      $('setting-gateway-port').value = config.gatewayPort;
      $('data-location').textContent = `用户数据：${settings.userData}`;
      if (settings.workflowConflicts?.length) $('settings-result').textContent = `升级保留了用户修改的工作流，需手动合并新版：${settings.workflowConflicts.join(', ')}`;
    }
    $('electron-version').textContent = info.electron;
    $('node-version').textContent = info.node;
    $('chrome-version').textContent = info.chrome;
    $('app-version').textContent = `桌面端 ${info.version} · ${info.platform}`;
    render(initial);
    document.documentElement.dataset.ready = 'true';
  } catch (error) { $('status').textContent = `桌面桥接失败：${error.message}`; }
})();

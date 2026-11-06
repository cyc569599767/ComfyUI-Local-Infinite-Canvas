'use strict';

const $ = (id) => document.getElementById(id);
let busy = false;
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
  for (const button of document.querySelectorAll('[data-page]')) {
    button.disabled = button.dataset.page !== 'dashboard' && !state.services?.[button.dataset.page]?.ready;
    button.classList.toggle('active', button.dataset.page === (state.activePage || 'dashboard'));
  }
  logView.update(state.logs, state.logsVersion);
  if (state.activePage === 'dashboard' && previousPage !== 'dashboard') logView.refresh();
}

async function perform(action) {
  busy = true;
  if (state) render(state);
  try { await action(); }
  catch (error) { $('connection-message').textContent = error.message; }
  finally { busy = false; if (state) { $('connect').disabled = ['connecting','stopping'].includes(state.phase); $('refresh').disabled = $('connect').disabled; } }
}

window.desktop.onState(render);
$('connect').addEventListener('click', () => perform(() => window.desktop.connect()));
$('refresh').addEventListener('click', () => perform(() => window.desktop.refresh()));
$('reload').addEventListener('click', () => perform(() => window.desktop.reloadPage()));
$('devtools').addEventListener('click', () => perform(() => window.desktop.openDevTools()));
for (const button of document.querySelectorAll('[data-page]')) {
  button.addEventListener('click', () => perform(() => window.desktop.showPage(button.dataset.page)));
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

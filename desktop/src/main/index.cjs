'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell } = require('electron');
const { getRuntimeInfo, isTrustedSender } = require('./runtime.cjs');
const { ServiceManager, request } = require('./services.cjs');
const { createApplication } = require('./application.cjs');
const { isAllowedNavigation, isExternalLink, sessionResponse } = require('./content-policy.cjs');

const rendererPath = path.join(__dirname, '../renderer/index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const isSmokeTest = process.argv.includes('--smoke-test');
const isDistributionTest = process.argv.includes('--distribution-smoke');
const isManagedTest = process.argv.includes('--managed-integration') || isDistributionTest;
const isIntegrationTest = process.argv.includes('--integration-smoke') || isManagedTest;
const testing = isSmokeTest || isIntegrationTest;
const isDevelopment = !app.isPackaged && process.argv.includes('--dev');
const root = path.resolve(__dirname, '../../..');
const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(root, 'desktop/.build/runtime');
const testWorkspace = testing && process.argv.find(arg => arg.startsWith('--test-workspace='))?.slice('--test-workspace='.length);
if (isDistributionTest) {
  const testData = process.argv.find(arg => arg.startsWith('--test-user-data='))?.slice('--test-user-data='.length);
  if (!testData || !path.isAbsolute(testData)) throw new Error('Distribution smoke requires an absolute temporary --test-user-data');
  app.setPath('userData', testData);
}
const manager = new ServiceManager({ root: testWorkspace ? path.resolve(testWorkspace) : (testing && !isDistributionTest ? root : runtimeRoot) });
let application = null;
const contentSessionName = testing ? 'desktop-test-content' : 'persist:canvas-desktop';
const toolbarHeight = 64;
let mainWindow = null;
let contentView = null;
let contentSession = null;
let activePage = 'dashboard';
let quitting = false;
let allowQuit = false;
let navigationId = 0;
const popups = new Set();
const pageViews = new Map();
const trustedContents = new Set();

function currentOrigins() {
  return new Set(Object.values(manager.state.services || {}).map((service) => service.url));
}

function publish() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:state', { ...manager.snapshot(), activePage });
  }
}
manager.on('change', publish);

async function externalLink(url) {
  if (testing || !isExternalLink(url)) return;
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: '打开外部链接', message: '是否在系统浏览器打开此地址？',
    detail: url, buttons: ['取消', '打开浏览器'], defaultId: 0, cancelId: 0,
  });
  if (answer.response === 1) await shell.openExternal(url);
}

function secureContents(contents) {
  trustedContents.add(contents.id);
  contents.once('destroyed', () => trustedContents.delete(contents.id));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  for (const eventName of ['will-navigate', 'will-redirect']) {
    contents.on(eventName, (event, url) => {
      if (!isAllowedNavigation(url, currentOrigins())) {
        event.preventDefault();
        if (eventName === 'will-navigate') void externalLink(url);
      }
    });
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url, currentOrigins())) {
      void externalLink(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 1100, height: 800, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, webviewTag: false, partition: contentSessionName, preload: undefined },
    } };
  });
  contents.on('did-create-window', (window) => {
    popups.add(window);
    secureContents(window.webContents);
    window.on('closed', () => popups.delete(window));
  });
}

async function configureContentSession() {
  contentSession = session.fromPartition(contentSessionName);
  const canvasClipboard = (contents) => Boolean(contents && trustedContents.has(contents.id)
    && isAllowedNavigation(contents.getURL(), new Set([manager.state.services?.canvas.url])));
  contentSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    ['clipboard-read', 'clipboard-sanitized-write'].includes(permission) && canvasClipboard(contents)
      && details?.isMainFrame === true && isAllowedNavigation(requestingOrigin, new Set([manager.state.services?.canvas.url])));
  contentSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!canvasClipboard(contents) || details?.isMainFrame !== true
      || !isAllowedNavigation(details.requestingUrl, new Set([manager.state.services?.canvas.url]))) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (permission !== 'clipboard-read' || testing) return callback(false);
    dialog.showMessageBox(mainWindow, {
      type: 'question', title: '读取剪贴板', message: '允许画布读取剪贴板以粘贴内容？',
      buttons: ['取消', '允许本次'], defaultId: 0, cancelId: 0,
    }).then(({ response }) => callback(response === 1), () => callback(false));
  });
  contentSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存画布导出文件' });
  });
  await contentSession.protocol.handle('http', (req) => {
    const services = manager.state.services;
    const response = services && sessionResponse(req, services.gateway.url, services.canvas.url);
    // Preserve POST bodies, streaming/SSE, cookies and CORS of ordinary requests.
    return response || contentSession.fetch(req, { bypassCustomProtocolHandlers: true, redirect: 'manual' }).catch(() =>
      new Response('{"error":"Local service unavailable"}', { status: 502, headers: { 'content-type': 'application/json' } }));
  });
}

function layoutContent() {
  if (!contentView || !mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  contentView.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) });
}

async function showPage(target) {
  if (!['dashboard', 'canvas', 'gateway', 'comfy'].includes(target)) throw new Error('未知页面');
  const ticket = ++navigationId;
  if (target === 'dashboard') {
    for (const view of pageViews.values()) view.setVisible(false);
    activePage = target;
    publish();
    return;
  }
  const service = manager.state.services?.[target];
  if (!service?.ready) throw new Error('该服务尚未就绪，请在服务面板检查连接');
  const url = `${service.url}${target === 'gateway' ? '/admin' : '/'}`;
  for (const view of pageViews.values()) view.setVisible(false);
  contentView = pageViews.get(target);
  if (!contentView) {
    contentView = new WebContentsView({ webPreferences: {
      partition: contentSessionName, contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: false,
    } });
    pageViews.set(target, contentView);
    mainWindow.contentView.addChildView(contentView);
    secureContents(contentView.webContents);
    const createdView = contentView;
    const failed = (reason) => {
      createdView.needsReload = true;
      manager.log(reason);
      if (activePage === target) void showPage('dashboard');
    };
    createdView.webContents.on('render-process-gone', (_event, details) => failed(`页面进程退出：${details.reason}`));
    createdView.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) failed(`页面加载失败：${description} (${code})`);
    });
  }
  layoutContent();
  contentView.setVisible(true);
  activePage = target;
  publish();
  try {
    if (contentView.needsReload || !contentView.webContents.getURL() || new URL(contentView.webContents.getURL()).origin !== service.url) {
      contentView.needsReload = false;
      await contentView.webContents.loadURL(url);
    }
  } catch (error) {
    if (ticket === navigationId) { await showPage('dashboard'); throw error; }
  }
}

async function connect(existingOnly = false) {
  await manager.connect({ existingOnly });
  if (!quitting) await showPage('canvas');
  return { ...manager.snapshot(), activePage };
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 980, minHeight: 660, show: false,
    title: 'ComfyUI · 本地无限画布桌面端', backgroundColor: '#10131a', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false },
  });
  mainWindow = window;
  window.once('ready-to-show', () => {
    if (!testing) window.show();
    else if (isIntegrationTest) window.showInactive();
  });
  window.on('resize', layoutContent);
  window.on('close', (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  window.on('closed', () => { mainWindow = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  await window.loadFile(rendererPath);
  return window;
}

async function requestQuit(relaunch = false) {
  if (quitting) return;
  quitting = true;
  try {
    if (!testing && (pageViews.has('canvas') || await manager.activeWork())) {
      const busy = await manager.activeWork();
      const answer = await dialog.showMessageBox(mainWindow, {
        type: busy ? 'warning' : 'question', title: '退出桌面端',
        message: busy ? '检测到任务、其他浏览器会话，或无法确认任务状态。' : '确认已保存最近的编辑并退出？',
        detail: '关闭画布会中断尚未完成的页面请求。桌面端启动的服务将停止；外部服务不由桌面端主动停止。请等待生成完成后再退出。',
        buttons: ['继续使用', '确认退出'], defaultId: 0, cancelId: 0,
      });
      if (answer.response !== 1) { quitting = false; return; }
      // Give the shipped canvas's 400 ms debounced write a chance to run.
      // This is not a formal application-level save acknowledgment.
      await new Promise(resolve => setTimeout(resolve, 600));
      contentSession.flushStorageData();
    }
    for (const popup of popups) popup.destroy();
    for (const view of pageViews.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    pageViews.clear();
    contentView = null;
    await manager.stop();
    allowQuit = true;
    if (relaunch) app.relaunch();
    app.quit();
  } catch (error) {
    manager.log(error.message);
    await showPage('dashboard');
    quitting = false;
    if (!testing) dialog.showErrorBox('服务清理未完成', error.message);
    else { console.error(error); app.exit(1); }
  }
}

function registerIPC() {
  const handlers = {
    'app:get-runtime-info': () => ({ ...getRuntimeInfo(app), packaged: app.isPackaged, development: isDevelopment }),
    'app:get-config': () => application ? { config: application.readConfig(), userData: application.userData, workflowConflicts: application.conflicts } : null,
    'app:save-config': (_event, value) => {
      if (!application) throw new Error('测试模式不修改用户配置');
      application.saveConfig(value);
      return { saved: true, restartRequired: true };
    },
    'app:choose-comfy': async () => {
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择 ComfyUI 安装目录', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
    'app:open-data': () => application && shell.openPath(application.userData),
    'app:restart': () => requestQuit(true),
    'app:get-state': () => ({ ...manager.snapshot(), activePage }),
    'app:connect': () => connect(),
    'app:refresh': () => manager.connect({ existingOnly: true }),
    'app:show-page': (_event, target) => showPage(target),
    'app:reload-page': () => {
      if (activePage !== 'dashboard') contentView?.webContents.reload();
    },
    'app:devtools': () => {
      if (isDevelopment) (activePage === 'dashboard' ? mainWindow.webContents : contentView?.webContents)?.openDevTools({ mode: 'detach' });
    },
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event, mainWindow, rendererUrl)) throw new Error('Untrusted IPC sender');
      return handler(event, ...args);
    });
  }
}

async function captureTestImage(contents, file) {
  // Windows compositor may temporarily have no surface after switching native
  // child views. Retry only the read-only screenshot, not application actions.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { fs.writeFileSync(file, (await contents.capturePage()).toPNG()); return; }
    catch (error) {
      if (attempt === 2) throw new Error(`Screenshot capture failed (${path.basename(file)}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function runSmokeTest() {
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const info = await window.desktop.getRuntimeInfo();
    const deadline = Date.now() + 5000;
    while (document.documentElement.dataset.ready !== 'true') {
      if (Date.now() > deadline) throw new Error('Renderer did not become ready');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { info, nodeIsolated: typeof process === 'undefined' && typeof require === 'undefined',
      displayedElectron: document.getElementById('electron-version').textContent };
  })()`);
  if (result.info.electron !== '41.0.3' || !result.nodeIsolated || result.displayedElectron !== '41.0.3') {
    throw new Error(`Smoke test failed: ${JSON.stringify(result)}`);
  }
  if (isIntegrationTest) {
    await connect(!isManagedTest); // Managed integration uses an explicitly isolated test workspace.
    const url = manager.state.services.gateway.url;
    const before = await request(`${url}/api/session/status`);
    result.canvas = await contentView.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 20000;
      while (!document.querySelector('#root')?.children.length) {
        if (Date.now() > deadline) throw new Error('Canvas did not mount');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const health = await fetch(${JSON.stringify(url + '/health')}).then(r => r.json());
      const lifecycle = await fetch(${JSON.stringify(url + '/api/session/close')}, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({id:'desktop-smoke-no-side-effects'})
      }).then(r => r.json());
      return { title: document.title, rootChildren: document.querySelector('#root').children.length,
        nodeIsolated: typeof process === 'undefined' && typeof require === 'undefined',
        noPrivilegedBridge: typeof window.desktop === 'undefined', health: health.status,
        lifecycleIsolated: lifecycle.desktop === true };
    })()`);
    const after = await request(`${url}/api/session/status`);
    if (!result.canvas.nodeIsolated || !result.canvas.noPrivilegedBridge || !result.canvas.lifecycleIsolated
      || result.canvas.health !== 'ok' || before?.json.closedAt !== after?.json.closedAt) {
      throw new Error(`Integration failed: ${JSON.stringify(result)}`);
    }
    result.services = manager.state.services;
    const canvasContents = contentView.webContents;
    if (isDistributionTest) {
      result.desktopMenu = await mainWindow.webContents.executeJavaScript("document.querySelector('[data-page=canvas]').textContent");
      if (result.desktopMenu !== '无界工作台') throw new Error('Desktop workbench label mismatch');
      result.navigation = await canvasContents.executeJavaScript(`(async () => {
        const links = [...document.querySelectorAll('header nav a')];
        const projects = links.findIndex(link => link.getAttribute('href') === '/projects');
        const canvas = links.findIndex(link => link.getAttribute('href') === '/canvas');
        if (projects < 0 || canvas !== projects + 1 || links[projects].textContent.trim() !== '我的项目') {
          throw new Error('My Projects must immediately precede My Canvases');
        }
        links[projects].click();
        const deadline = Date.now() + 10000;
        while (document.querySelector('main h1')?.textContent !== '我的项目') {
          if (Date.now() > deadline) throw new Error('Projects menu did not open its library');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return { order: links.map(link => link.textContent.trim()), path: location.pathname,
          active: document.querySelector('header nav a[aria-current=page]')?.getAttribute('href') };
      })()`);
      if (result.navigation.path !== '/projects' || result.navigation.active !== '/projects') throw new Error('Projects route/active state mismatch');
      await canvasContents.loadURL(`${manager.state.services.canvas.url}/projects`);
      await canvasContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 10000;
        while (document.querySelector('main h1')?.textContent !== '我的项目') {
          if (Date.now() > deadline) throw new Error('Projects deep-link reload failed');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      })()`);
      result.navigation.deepLinkReload = true;
      const navigationDir = path.join(application.userData, 'test-artifacts');
      fs.mkdirSync(navigationDir, { recursive: true });
      await captureTestImage(canvasContents, path.join(navigationDir, 'projects-menu.png'));
    }
    await canvasContents.loadURL(`${manager.state.services.canvas.url}/canvas?mode=recent`);
    result.project = await canvasContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (!document.querySelector('[data-canvas-bottom-toolbar]')) {
        if (Date.now() > deadline) throw new Error('Canvas editor did not mount');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      window.__desktopTestMarker = 'preserved';
      return { path: location.pathname, toolbar: true };
    })()`);
    if (isDistributionTest) {
      await canvasContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 10000;
        const database = await new Promise((resolve, reject) => {
          const open = indexedDB.open('infinite-canvas');
          open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        try {
          for (;;) {
            const saved = await new Promise((resolve, reject) => {
              const read = database.transaction('app_state').objectStore('app_state').get('infinite-canvas:canvas_store');
              read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
            });
            if (saved && JSON.parse(saved).state.projects.some(project => '/canvas/' + project.id === location.pathname)) break;
            if (Date.now() > deadline) throw new Error('Project was not persisted before library navigation');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } finally { database.close(); }
      })()`);
      await canvasContents.loadURL(`${manager.state.services.canvas.url}/projects`);
      const projectPath = result.project.path;
      await canvasContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 10000;
        let title;
        while (!(title = document.querySelector('main article button h2'))) {
          if (Date.now() > deadline) throw new Error('Projects library did not show the saved canvas');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        title.closest('button').click();
        while (!document.querySelector('[data-canvas-bottom-toolbar]')) {
          if (Date.now() > deadline) throw new Error('Opening project from library failed');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (location.pathname !== ${JSON.stringify(projectPath)}) throw new Error('Projects opened a different canvas');
        window.__desktopTestMarker = 'preserved';
      })()`);
      result.navigation.projectOpen = true;
    }
    const adminResponse = await request(`${url}/admin`);
    if (!adminResponse?.text.includes('id="workflows"')) throw new Error('Gateway /admin did not serve the HTML management page');
    await showPage('gateway');
    result.gatewayPage = await contentView.webContents.executeJavaScript(`(async () => {
      if (document.title !== 'ComfyUI Gateway' || !document.getElementById('workflows')) {
        throw new Error('Gateway management page is missing or is an HTTP error document');
      }
      const deadline = Date.now() + 15000;
      while (document.getElementById('workflows').textContent === '加载中…') {
        if (Date.now() > deadline) throw new Error('Gateway workflows did not load');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (document.getElementById('workflows').textContent.startsWith('加载失败：')) {
        throw new Error(document.getElementById('workflows').textContent);
      }
      const response = await fetch('/api/workflows');
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.workflows)) throw new Error('Gateway workflow API failed');
      return { title: document.title, renderedWorkflows: Number(document.getElementById('count').textContent), workflowApi: true };
    })()`);
    const gatewayArtifacts = application ? path.join(application.userData, 'test-artifacts') : path.join(root, 'desktop/test/artifacts');
    fs.mkdirSync(gatewayArtifacts, { recursive: true });
    await captureTestImage(contentView.webContents, path.join(gatewayArtifacts, 'gateway-admin.png'));
    if (process.argv.includes('--test-redirect')) {
      await contentView.webContents.loadURL(`${manager.state.services.gateway.url}/desktop-test-redirect`).catch(() => {});
      result.externalRedirectBlocked = !await contentView.webContents.executeJavaScript("document.body.innerText.includes('Untrusted redirect')");
      if (!result.externalRedirectBlocked) throw new Error('External redirect was not blocked');
      result.postBodyForwarded = await canvasContents.executeJavaScript(`fetch(${JSON.stringify(url + '/desktop-test-echo')}, {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({desktopProbe:'body-preserved'})
      }).then(r => r.json()).then(body => body.desktopProbe === 'body-preserved')`);
      if (!result.postBodyForwarded) throw new Error('HTTP POST body not preserved');
    }
    if (manager.state.services.comfy.ready) {
      await showPage('comfy');
      result.comfyPage = await contentView.webContents.executeJavaScript('document.body.children.length > 0');
    }
    await showPage('canvas');
    result.projectPreserved = contentView.webContents.id === canvasContents.id
      && await canvasContents.executeJavaScript("window.__desktopTestMarker === 'preserved'");
    if (!result.projectPreserved) throw new Error('Switching tabs reloaded the canvas');
    const artifactDir = application ? path.join(application.userData, 'test-artifacts') : path.join(root, 'desktop/test/artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const downloadPath = path.join(artifactDir, 'download-smoke.txt');
    const downloaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Blob download timed out')), 5000);
      contentSession.once('will-download', (_event, item) => {
        item.setSavePath(downloadPath);
        item.once('done', (_event, state) => {
          clearTimeout(timer);
          state === 'completed' ? resolve() : reject(new Error(`Download ${state}`));
        });
      });
    });
    await canvasContents.executeJavaScript(`{
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['desktop-download-ok'], {type:'text/plain'}));
      link.download = 'download-smoke.txt'; link.click();
    }`);
    await downloaded;
    if (fs.readFileSync(downloadPath, 'utf8') !== 'desktop-download-ok') throw new Error('Blob download content mismatch');
    result.blobDownload = true;
    await captureTestImage(contentView.webContents, path.join(artifactDir, 'canvas.png'));
    await showPage('dashboard');
    await mainWindow.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await captureTestImage(mainWindow.webContents, path.join(artifactDir, 'dashboard.png'));
  }
  console.log(`${isIntegrationTest ? 'INTEGRATION' : 'SMOKE'}_TEST_OK ${JSON.stringify(result)}`);
  await requestQuit();
}

async function fail(error) {
  console.error('[desktop]', error);
  try { application?.log(error.stack || error.message); } catch { /* no writable log yet */ }
  if (!mainWindow && !testing) { dialog.showErrorBox('桌面应用启动失败', error.message); allowQuit = true; app.exit(1); return; }
  if (testing) { await manager.stop().catch(console.error); app.exit(1); }
  else manager.update({ phase: 'error', message: error.message });
}

if (!testing && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.restore(); mainWindow.focus(); } });
  app.on('before-quit', (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  app.on('window-all-closed', () => { if (!allowQuit) void requestQuit(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.comfycanvas.desktop');
    if (!testing || isDistributionTest) {
      application = createApplication({ runtimeRoot, userData: app.getPath('userData') });
      manager.root = application.runtimeRoot;
      manager.env = application.env;
      let lastLog = '';
      manager.on('change', (state) => {
        const message = state.logs.at(-1);
        if (message && message !== lastLog) { lastLog = message; try { application.log(message); } catch { /* disk failures must not crash */ } }
      });
      application.log(`启动桌面端 ${app.getVersion()} (${app.isPackaged ? 'installed' : 'development'})`);
    }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await configureContentSession();
    registerIPC();
    await createWindow();
    if (testing) await runSmokeTest();
    else await connect();
  }).catch(fail);
}

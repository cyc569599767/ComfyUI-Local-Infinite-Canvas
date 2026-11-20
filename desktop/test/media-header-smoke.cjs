'use strict';
// Isolated Electron regression: no real generation, user profile or service startup.
// Optional --live-url reads an existing local /view video; never writes upstream.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = path.resolve(__dirname, '../..');
const filename = '镜头7 旋转铁梯 · 抱油桶滚落又爬起-视频.mp4';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const output = path.resolve(arg('output') || path.join(root, 'deliverables/video-header-fix'));
  assert.ok(fs.existsSync(output), 'Create evidence parent first');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  (async () => {
    for (const mode of ['before', 'after']) {
      const profile = path.join(output, `test-profile-${mode}-${randomUUID()}`);
      const args = [__filename, `--mode=${mode}`, `--output=${output}`, `--user-data-dir=${profile}`];
      if (arg('live-url') && mode === 'after') args.push(`--live-url=${arg('live-url')}`);
      const child = spawn(require('electron'), args, { stdio: 'inherit', env });
      const timer = setTimeout(() => child.kill(), 60000);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      clearTimeout(timer);
      assert.equal(code, 0, `${mode} smoke exit`);
      const report = JSON.parse(fs.readFileSync(path.join(output, `${mode}.json`), 'utf8'));
      assert.equal(report.ok, true, `${mode}: ${JSON.stringify(report)}`);
      console.log(`MEDIA_HEADER_${mode.toUpperCase()}_OK ${JSON.stringify({ checks: report.checks?.length, reproduced: report.reproduced, live: report.live?.filename })}`);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, session, BrowserWindow } = require('electron');
  const { installComfyMediaHeaderPolicy, sessionResponse } = require('../src/main/content-policy.cjs');
  const mode = arg('mode'); const output = arg('output');
  const report = { mode, electron: process.versions.electron, checks: [], errors: [] };
  let server; let window; let finished = false;
  const finish = (ok, error) => {
    if (finished) return; finished = true;
    if (error) report.errors.push(error.stack || String(error));
    report.ok = ok;
    fs.writeFileSync(path.join(output, `${mode}.json`), JSON.stringify(report, null, 2));
    window?.destroy(); server?.closeAllConnections(); server?.close(); app.exit(ok ? 0 : 1);
  };
  process.on('uncaughtException', error => {
    if (mode === 'before' && /ByteString/.test(error.message) && /38236/.test(error.message)) {
      report.reproduced = error.message; finish(true);
    } else finish(false, error);
  });
  process.on('unhandledRejection', error => finish(false, error));
  const check = (name, fn) => { fn(); report.checks.push(name); };
  const nodeRead = (url, options = {}) => new Promise((resolve, reject) => {
    http.request(url, options, response => {
      const chunks = []; response.on('data', data => chunks.push(data));
      response.on('end', () => resolve({ body: Buffer.concat(chunks), status: response.statusCode, headers: response.headers }));
      response.on('error', reject);
    }).on('error', reject).end();
  });
  const rendererMedia = async url => {
    const video = document.querySelector('video');
    const once = (event, start) => new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error(`video ${event}: ${video.error?.message}`)); };
      const timer = setTimeout(fail, 12000);
      const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', fail); };
      video.addEventListener(event, done, { once: true }); video.addEventListener('error', fail, { once: true }); start();
    });
    await once('loadeddata', () => { video.src = url; video.load(); });
    const info = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    const target = Math.min(0.6, video.duration / 2);
    await once('seeked', () => { video.currentTime = target; });
    info.seek = video.currentTime;
    await video.play();
    await once('timeupdate', () => {});
    info.playTime = video.currentTime; info.frames = video.getVideoPlaybackQuality().totalVideoFrames;
    video.pause(); return info;
  };
  app.whenReady().then(async () => {
    app.on('window-all-closed', () => {});
    const body = fs.readFileSync(path.join(root, 'comfyui-gateway/mock/assets/mock.mp4'));
    const requests = [];
    server = http.createServer((req, res) => {
      requests.push({ method: req.method, path: req.url, range: req.headers.range || null });
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/echo') { const data = []; req.on('data', chunk => data.push(chunk)); req.on('end', () => res.end(Buffer.concat(data))); return; }
      if (req.url === '/sse') { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: first\n\n'); res.end('data: done\n\n'); return; }
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/view' }); res.end(); return; }
      if (req.url.startsWith('/view') || req.url.startsWith('/api/view')) {
        const attachment = req.url.includes('attachment');
        res.setHeader('Content-Disposition', Buffer.from(`${attachment ? 'attachment; ' : ''}filename="${filename}"`, 'utf8').toString('latin1'));
        res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes');
        let start = 0; let end = body.length - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          else start = Math.max(0, body.length - Number(match[2]));
          if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}`, 'Content-Length': 0 }); res.end(); return; }
          res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
        }
        res.setHeader('Content-Length', end - start + 1);
        res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1)); return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>中文视频响应头回归</title><style>body{background:#f4f6fa;color:#182239;font:18px system-ui;padding:28px}video{width:740px;height:420px;background:#e5e9ef}p{line-height:1.7}</style><h2>中文视频：预览 / 播放 / 定位验证</h2><p id="status">隔离测试会话，不触发生成、不修改原素材</p><video muted controls></video></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let comfyOrigin = origin;
    const ses = session.fromPartition(`header-smoke-${mode}`);
    if (mode === 'after') installComfyMediaHeaderPolicy({ webRequest: { onHeadersReceived: listener => ses.webRequest.onHeadersReceived((details, callback) => {
      report.headerEvents ||= [];
      listener(details, result => { report.headerEvents.push({ url: details.url, before: details.responseHeaders, after: result.responseHeaders }); callback(result); });
    }) } }, () => comfyOrigin);
    if (mode === 'before') {
      await ses.fetch(`${origin}/view?filename=${encodeURIComponent(filename)}`, { method: 'HEAD' });
      throw new Error('Expected original Electron ByteString exception was not reproduced');
    }
    const inspect = async (url, options = {}) => {
      const response = await ses.fetch(url, { ...options, bypassCustomProtocolHandlers: true, redirect: 'manual' });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.length, hash: sha256(bytes) };
    };
    for (const [name, options, status, expected] of [
      ['GET full', {}, 200, body], ['HEAD', { method: 'HEAD' }, 200, Buffer.alloc(0)],
      ['range start', { headers: { range: 'bytes=0-127' } }, 206, body.subarray(0, 128)],
      ['range suffix', { headers: { range: 'bytes=-128' } }, 206, body.subarray(-128)],
      ['HEAD range', { method: 'HEAD', headers: { range: 'bytes=0-127' } }, 206, Buffer.alloc(0)],
      ['invalid range', { headers: { range: 'bytes=999999-' } }, 416, Buffer.alloc(0)],
    ]) {
      const result = await inspect(`${origin}/view?filename=${encodeURIComponent(filename)}`, options);
      check(name, () => { assert.equal(result.status, status); assert.equal(result.hash, sha256(expected)); assert.match(result.headers['content-disposition'], /^[\x20-\x7e]+$/); assert.equal(decodeURIComponent(result.headers['content-disposition'].split("filename*=UTF-8''")[1]), filename); });
    }
    const attachment = await inspect(`${origin}/api/view?attachment`);
    check('attachment remains attachment', () => assert.match(attachment.headers['content-disposition'], /^attachment;/));
    await ses.protocol.handle('http', req => sessionResponse(req, origin, origin) || ses.fetch(req, { bypassCustomProtocolHandlers: true, redirect: 'manual' }));
    window = new BrowserWindow({ show: false, width: 860, height: 660, webPreferences: { offscreen: true, session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadURL(origin);
    const renderer = await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch('/view', {headers:{range:'bytes=0-127'}});
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const echo = await (await fetch('/echo', {method:'POST',body:'Chinese payload preserved'})).text();
      const sse = await (await fetch('/sse')).text();
      const lifecycle = await (await fetch('/api/session/heartbeat', {method:'POST'})).json();
      return {status:response.status,hash,echo,sse,lifecycle};
    })()`);
    check('renderer protocol Range body unchanged', () => { assert.equal(renderer.status, 206); assert.equal(renderer.hash, sha256(body.subarray(0, 128))); });
    check('POST body unaffected', () => assert.equal(renderer.echo, 'Chinese payload preserved'));
    check('SSE body unaffected', () => assert.equal(renderer.sse, 'data: first\n\ndata: done\n\n'));
    check('legacy lifecycle interception unaffected', () => { assert.equal(renderer.lifecycle.desktop, true); assert.equal(requests.some(row => row.path.includes('/api/session/')), false); });
    const beforeRedirectRequests = requests.length;
    await assert.rejects(() => inspect(`${origin}/redirect`), /Redirect was cancelled/);
    check('manual redirect remains blocked', () => assert.equal(requests.length, beforeRedirectRequests + 1));
    const downloadName = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('download filename timeout')), 8000);
      ses.once('will-download', (event, item) => { event.preventDefault(); clearTimeout(timer); resolve(item.getFilename()); });
      window.webContents.downloadURL(`${origin}/api/view?attachment&filename=${encodeURIComponent(filename)}`);
    });
    check('download keeps original Chinese filename without saving any file', () => assert.equal(downloadName, filename));
    report.downloadName = downloadName;
    const media = await window.webContents.executeJavaScript(`(${rendererMedia.toString()})(${JSON.stringify(`${origin}/view?filename=${encodeURIComponent(filename)}`)})`);
    report.fixtureMedia = media;
    check('fixture video decode seek playback', () => { assert.equal(media.width, 512); assert.ok(media.playTime > media.seek); assert.ok(media.frames > 0); });
    if (arg('live-url')) {
      const liveUrl = new URL(arg('live-url'));
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(liveUrl.hostname));
      assert.equal(liveUrl.protocol, 'http:'); assert.equal(liveUrl.pathname, '/view');
      const baseline = await nodeRead(liveUrl);
      assert.equal(baseline.status, 200);
      comfyOrigin = liveUrl.origin;
      const full = await inspect(liveUrl.toString());
      const partial = await inspect(liveUrl.toString(), { headers: { range: 'bytes=0-127' } });
      report.live = { filename: liveUrl.searchParams.get('filename'), baselineBytes: baseline.body.length, baselineHash: sha256(baseline.body), full, partial };
      check('real generated Chinese video full bytes unchanged', () => { assert.equal(full.status, 200); assert.equal(full.hash, sha256(baseline.body)); });
      check('real generated Chinese video range unchanged', () => { assert.equal(partial.status, 206); assert.equal(partial.hash, sha256(baseline.body.subarray(0, 128))); });
      report.live.media = await window.webContents.executeJavaScript(`(${rendererMedia.toString()})(${JSON.stringify(liveUrl.toString())})`);
      check('real generated video decode seek playback', () => { assert.ok(report.live.media.width > 0); assert.ok(report.live.media.frames > 0); assert.ok(report.live.media.playTime > report.live.media.seek); });
      await window.webContents.executeJavaScript(`document.querySelector('#status').textContent=${JSON.stringify(`真实已生成素材：${report.live.filename}；只读播放验证通过`)}`);
    }
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, 'playback.png'), screenshot.toPNG());
    report.requests = requests;
    finish(true);
  }).catch(error => finish(false, error));
}

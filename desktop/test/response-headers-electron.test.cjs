'use strict';
// Real Electron networking against a synthetic loopback server. No production
// main process, ComfyUI, models, user data or existing desktop tasks are opened.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { installResponseHeaderGuard } = require('../src/main/response-headers.cjs');
const payload = Buffer.from('synthetic-image-bytes-0123456789');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function electronProbe() {
  const { app, session, BrowserWindow } = require('electron');
  const cfg = JSON.parse(process.env.HEADER_PROBE);
  app.setPath('userData', cfg.profile);
  app.setPath('sessionData', path.join(cfg.profile, 'session'));
  app.commandLine.appendSwitch('disable-background-networking');
  const report = { mode: cfg.mode, electron: process.versions.electron, node: process.versions.node };
  // Contain the known Electron bug in this test process only, not production.
  process.once('uncaughtException', error => {
    report.uncaught = { name: error.name, message: error.message, stack: error.stack };
    fs.writeFileSync(cfg.report, JSON.stringify(report));
    app.exit(cfg.mode === 'baseline' ? 0 : 1);
  });
  await app.whenReady();
  const ses = session.fromPartition(`header-probe-${cfg.mode}`);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url.startsWith('http') && new URL(details.url).origin !== cfg.origin }));
  if (cfg.mode === 'guarded') installResponseHeaderGuard(ses);
  if (cfg.mode === 'baseline') {
    // Electron 41 manual redirects reject instead of exposing a 302 Response.
    await assert.rejects(ses.fetch(`${cfg.origin}/redirect`, { redirect: 'manual' }), /Redirect was cancelled/);
    report.manualRedirectBlocked = true;
    await ses.fetch(`${cfg.origin}/image`, { redirect: 'manual' });
    throw Error('Expected original ByteString conversion failure was not reproduced');
  }
  report.cases = [];
  for (const [method, route, expectedStatus, expectedBody] of [
    ['GET', '/image', 200, payload], ['HEAD', '/image', 200, Buffer.alloc(0)],
    ['GET', '/range', 206, payload.subarray(0, 8)], ['GET', '/chunked', 200, payload],
    ['GET', '/attachment', 200, payload],
  ]) {
    const response = await ses.fetch(cfg.origin + route, { method, redirect: 'manual', headers: route === '/range' ? { Range: 'bytes=0-7' } : {} });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(body, expectedBody);
    const disposition = response.headers.get('content-disposition');
    assert.ok(disposition && !/[^\u0000-\u00ff]/.test(disposition));
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), '桌面图片😀.png');
    if (route === '/attachment') { assert.match(disposition, /^attachment;/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); }
    if (route === '/range') { assert.equal(response.headers.get('content-range'), `bytes 0-7/${payload.length}`); assert.equal(response.headers.get('accept-ranges'), 'bytes'); }
    report.cases.push({ method, route, status: response.status, bytes: body.length, sha256: hash(body) });
  }
  await assert.rejects(ses.fetch(`${cfg.origin}/unknown`));
  report.unknownHeaderRejected = true;
  await assert.rejects(ses.fetch(`${cfg.origin}/redirect`, { redirect: 'manual' }), /Redirect was cancelled/);
  report.manualRedirectBlocked = true;
  const postBody = '中文 POST body';
  const post = await ses.fetch(`${cfg.origin}/echo`, { method: 'POST', body: postBody });
  assert.equal(await post.text(), postBody);
  const cookieResponse = await ses.fetch(`${cfg.origin}/cookie-set`, { credentials: 'include' }); await cookieResponse.arrayBuffer();
  const cookies = await ses.cookies.get({ url: cfg.origin });
  assert.ok(cookies.some(cookie => cookie.name === 'fixture' && cookie.value === 'value'));
  report.cookiesPreserved = true;
  // Same production protocol forwarding shape, exercised from sandboxed Chromium.
  await ses.protocol.handle('http', req => ses.fetch(req, { bypassCustomProtocolHandlers: true, redirect: 'manual' }).catch(() => new Response('blocked', { status: 502 })));
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  app.on('window-all-closed', () => {});
  await win.loadURL(cfg.origin + '/');
  const rendered = await win.webContents.executeJavaScript(`(async () => {
    const response = await fetch('/image');
    const body = new Uint8Array(await response.arrayBuffer());
    const post = await fetch('/echo', {method:'POST',body:'中文请求'});
    const range = await fetch('/range', {headers:{Range:'bytes=0-7'}});
    return { status: response.status, bytes: [...body], disposition: response.headers.get('content-disposition'), post: await post.text(), range: range.status, rangeBody: await range.text(), isolated: typeof process === 'undefined' };
  })()`);
  assert.equal(rendered.status, 200); assert.deepEqual(Buffer.from(rendered.bytes), payload);
  assert.equal(rendered.post, '中文请求'); assert.equal(rendered.range, 206); assert.equal(rendered.rangeBody, payload.subarray(0, 8).toString()); assert.equal(rendered.isolated, true);
  report.renderer = { status: rendered.status, byteExact: true, postPreserved: true, rangePreserved: true, sandboxed: true };
  const rejected = await win.webContents.executeJavaScript(`fetch('/unknown').then(response => response.status)`);
  assert.equal(rejected, 502, 'unsafe headers become a failed response, not a main-process exception');
  report.renderer.unsafeHeaderStatus = rejected;
  win.destroy(); ses.protocol.unhandle('http'); await ses.closeAllConnections();
  fs.writeFileSync(cfg.report, JSON.stringify(report));
  console.log('HEADER_PROBE_OK ' + JSON.stringify(report));
  app.exit(0);
}

if (process.versions.electron) {
  electronProbe().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const test = require('node:test');
  test('real Electron reproduces the Unicode crash and guarded HTTP forwarding stays byte-exact', { timeout: 60000 }, async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-header-probe-'));
    const calls = [];
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const requestBody = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      calls.push({ method: req.method, path: url.pathname });
      let body = payload, status = '200 OK';
      const headers = ['Content-Type: application/octet-stream', 'Cache-Control: no-store', 'Connection: close'];
      if (url.pathname === '/') { body = Buffer.from('<!doctype html><title>Fixture</title>'); headers[0] = 'Content-Type: text/html'; }
      else if (url.pathname === '/echo') body = requestBody;
      else if (url.pathname === '/unknown') headers.push('X-Unknown: 中文');
      else if (url.pathname === '/redirect') { status = '302 Found'; headers.push('Location: /image'); body = Buffer.alloc(0); }
      else if (url.pathname === '/cookie-set') { headers.push('Set-Cookie: fixture=value; HttpOnly; SameSite=Lax'); body = Buffer.alloc(0); }
      else {
        headers.push(`Content-Disposition: ${url.pathname === '/attachment' ? 'attachment; ' : ''}filename="桌面图片😀.png"`, 'X-Content-Type-Options: nosniff', 'Accept-Ranges: bytes');
        if (url.pathname === '/range') { status = '206 Partial Content'; headers.push(`Content-Range: bytes 0-7/${payload.length}`); body = payload.subarray(0, 8); }
      }
      const socket = res.socket;
      if (url.pathname === '/chunked') {
        headers.push('Transfer-Encoding: chunked');
        socket.write(Buffer.from(`HTTP/1.1 ${status}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8'));
        socket.write(Buffer.concat([Buffer.from('8\r\n'), body.subarray(0, 8), Buffer.from('\r\n')]));
        setTimeout(() => socket.end(Buffer.concat([Buffer.from(`${(body.length - 8).toString(16)}\r\n`), body.subarray(8), Buffer.from('\r\n0\r\n\r\n')])), 30);
      } else {
        headers.push(`Content-Length: ${body.length}`);
        socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${status}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8'), req.method === 'HEAD' ? Buffer.alloc(0) : body]));
      }
    });
    let active;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const mode of ['baseline', 'guarded']) {
        const profile = path.join(temporary, mode); fs.mkdirSync(profile);
        const reportPath = path.join(temporary, `${mode}.json`);
        const env = { ...process.env, HEADER_PROBE: JSON.stringify({ origin, mode, profile, report: reportPath }) };
        delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
        active = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { env, stdio: 'inherit', windowsHide: true });
        const exit = await new Promise((resolve, reject) => {
          const child = active;
          const timer = setTimeout(() => child.kill(), 25000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); active = null; resolve(code); });
        });
        assert.equal(exit, 0, `${mode} Electron probe exit`);
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        if (mode === 'baseline') { assert.match(report.uncaught?.message || '', /ByteString/); console.log('Reproduced original uncaught ByteString error in isolated Electron.'); }
        else { assert.equal(report.uncaught, undefined); assert.equal(report.cases.length, 5); assert.equal(report.renderer.byteExact, true); }
      }
      assert.ok(calls.every(call => ['/', '/image', '/range', '/chunked', '/attachment', '/unknown', '/redirect', '/echo', '/cookie-set'].includes(call.path)));
    } finally {
      if (active) { const child = active; child.kill(); await new Promise(resolve => child.once('close', resolve)); }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(temporary), os.tmpdir()); assert.ok(path.basename(temporary).startsWith('canvas-header-probe-'));
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}

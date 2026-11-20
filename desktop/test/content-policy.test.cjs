'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeMediaDisposition, normalizeComfyMediaHeaders, installComfyMediaHeaderPolicy } = require('../src/main/content-policy.cjs');

const filename = '镜头7 旋转铁梯 · 抱油桶滚落又爬起-视频_b0aa6a64-201_00001_.mp4';
const original = `filename="${filename}"`;
const decodeName = header => decodeURIComponent(/; filename\*=UTF-8''([^;]*)$/.exec(header)[1]);

test('exact screenshot error comes from Chinese ComfyUI disposition, fixed as RFC 5987', () => {
  assert.equal(original.charCodeAt(10), 38236);
  assert.throws(() => new Headers({ 'content-disposition': original }), /ByteString/);
  const fixed = normalizeMediaDisposition(original);
  assert.match(fixed, /^inline; filename=".*\.mp4"; filename\*=UTF-8''/);
  assert.match(fixed, /^[\x20-\x7e]+$/);
  assert.equal(decodeName(fixed), filename);
  assert.doesNotThrow(() => new Headers({ 'content-disposition': fixed }));
  assert.equal(normalizeMediaDisposition(fixed), fixed);
});

test('attachment disposition is never changed to inline', () => {
  const fixed = normalizeMediaDisposition('attachment; filename="中文.html"');
  assert.match(fixed, /^attachment;/);
  assert.equal(decodeName(fixed), '中文.html');
});

test('ASCII and already extended headers are untouched', () => {
  for (const value of ['filename="clip.mp4"', "attachment; filename*=UTF-8''%E9%95%9C.mp4", '', undefined]) {
    assert.equal(normalizeMediaDisposition(value), value);
  }
});

test('filename quoting, semicolons, percent signs and supplementary Unicode round trip', () => {
  const name = '镜头; 100% \\ path "quoted" (take)*\'𠮷.mp4';
  const header = `inline; filename="${name.replace(/["\\]/g, char => `\\${char}`)}"`;
  const fixed = normalizeMediaDisposition(header);
  assert.equal(decodeName(fixed), name);
  assert.match(fixed, /^[\x20-\x7e]+$/);
  assert.match(fixed, /%27/);
  assert.match(fixed, /%2A/);
  assert.doesNotThrow(() => new Headers({ 'content-disposition': fixed }));
});

test('unquoted filename and existing valid filename-star retain Unicode semantics', () => {
  assert.equal(decodeName(normalizeMediaDisposition('filename=场景.png')), '场景.png');
  const fixed = normalizeMediaDisposition("attachment; filename=中文.mp4; filename*=UTF-8''original.mp4");
  assert.equal(decodeName(fixed), 'original.mp4');
});

test('quoted parameter-like filename text cannot override the real name', () => {
  const name = "镜头; filename*=UTF-8''spoof.mp4";
  assert.equal(decodeName(normalizeMediaDisposition(`filename="${name}"`)), name);
});

test('Latin-1 names, malformed surrogate and unexpected non-ASCII parameter cannot crash', () => {
  for (const header of ['filename="café.mp4"', 'filename="镜\ud800.mp4"', 'attachment; x-label=中文']) {
    const fixed = normalizeMediaDisposition(header);
    assert.match(fixed, /^[\x20-\x7e]+$/);
    assert.doesNotThrow(() => new Headers({ 'content-disposition': fixed }));
  }
});

test('only ComfyUI media disposition changes; range, cookies, CORS and input stay intact', () => {
  const headers = { 'Content-Disposition': [original], 'Content-Range': ['bytes 0-127/2098207'], 'Content-Length': ['128'], 'Set-Cookie': ['one=1', 'two=2'], 'Access-Control-Allow-Origin': ['http://127.0.0.1:23110'] };
  const snapshot = JSON.stringify(headers);
  for (const pathname of ['/view', '/api/view']) {
    const fixed = normalizeComfyMediaHeaders({ url: `http://localhost:8188${pathname}?filename=${encodeURIComponent(filename)}`, responseHeaders: headers }, 'http://localhost:8188/');
    assert.equal(decodeName(fixed['Content-Disposition'][0]), filename);
    for (const key of Object.keys(headers).filter(key => key !== 'Content-Disposition')) assert.equal(fixed[key], headers[key]);
  }
  assert.equal(JSON.stringify(headers), snapshot);
});

test('lossy Electron header event uses the decoded query filename without changing attachment', () => {
  const url = `http://localhost:8188/view?${new URLSearchParams({ filename: `creation/${filename}` })}`;
  const fixed = normalizeComfyMediaHeaders({ url, responseHeaders: { 'content-disposition': ['attachment; filename="47 corrupt.mp4"'] } }, 'http://localhost:8188');
  assert.equal(decodeName(fixed['content-disposition'][0]), filename);
  assert.match(fixed['content-disposition'][0], /^attachment;/);
});

test('unrelated hosts, routes and already safe headers are not rewritten', () => {
  for (const url of ['http://localhost:8189/view', 'https://localhost:8188/view', 'http://localhost:8188/view_metadata/a', 'http://localhost:8188/prompt', 'https://example.com/view', 'invalid']) {
    assert.equal(normalizeComfyMediaHeaders({ url, responseHeaders: { 'content-disposition': [original] } }, 'http://localhost:8188'), null);
  }
  assert.equal(normalizeComfyMediaHeaders({ url: 'http://localhost:8188/view' }, ''), null);
  assert.equal(normalizeComfyMediaHeaders({ url: 'http://localhost:8188/view', responseHeaders: { 'content-disposition': ['filename="ascii.mp4"'] } }, 'http://localhost:8188'), null);
});

test('session hook uses current configured origin and calls callback exactly once', () => {
  let listener; let origin = 'http://localhost:8188'; let callbacks = 0;
  installComfyMediaHeaderPolicy({ webRequest: { onHeadersReceived: fn => { listener = fn; } } }, () => origin);
  const details = { url: `${origin}/view`, responseHeaders: { 'content-disposition': [original] } };
  listener(details, result => { callbacks++; assert.equal(decodeName(result.responseHeaders['content-disposition'][0]), filename); });
  origin = 'http://localhost:9999';
  listener(details, result => { callbacks++; assert.deepEqual(result, {}); });
  assert.equal(callbacks, 2);
});

test('production session installs normalization before any protocol fetch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.cjs'), 'utf8');
  const install = source.indexOf('installComfyMediaHeaderPolicy(contentSession, () => manager.state.services?.comfy?.url)');
  assert.ok(install > 0);
  assert.ok(install < source.indexOf("contentSession.protocol.handle('http'"));
  assert.match(source, /contentSession\.fetch\(req, \{ bypassCustomProtocolHandlers: true, redirect: 'manual' \}\)/);
});

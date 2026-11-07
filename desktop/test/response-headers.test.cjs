'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeResponseHeaders, installResponseHeaderGuard } = require('../src/main/response-headers.cjs');

test('production installs the header guard on its content session before the HTTP fetch handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.cjs'), 'utf8');
  const sessionStart = source.indexOf('contentSession = session.fromPartition(contentSessionName)');
  const guard = source.indexOf('installResponseHeaderGuard(contentSession)', sessionStart);
  const handler = source.indexOf("contentSession.protocol.handle('http'", sessionStart);
  assert.ok(sessionStart >= 0 && guard > sessionStart && handler > guard);
  assert.match(source, /contentSession\.fetch\(req, \{ bypassCustomProtocolHandlers: true, redirect: 'manual' \}\)/);
});

test('Comfy bare Unicode filename is converted before Headers ByteString conversion', () => {
  const headers = { 'Content-Disposition': ['filename="桤木图片.png"'], 'Content-Type': ['image/png'], 'Content-Length': ['512'], 'Accept-Ranges': ['bytes'], 'Content-Range': ['bytes 0-511/1024'] };
  const before = structuredClone(headers);
  assert.throws(() => new Headers({ 'Content-Disposition': headers['Content-Disposition'][0] }), /ByteString/);
  const fixed = safeResponseHeaders(headers).responseHeaders;
  assert.deepEqual(headers, before);
  assert.match(fixed['Content-Disposition'][0], /^filename="_+\.png"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(fixed['Content-Disposition'][0].split("UTF-8''")[1]), '桤木图片.png');
  assert.doesNotThrow(() => new Headers(Object.entries(fixed).map(([key, values]) => [key, values.join(', ')])));
  for (const key of ['Content-Type', 'Content-Length', 'Accept-Ranges', 'Content-Range']) assert.deepEqual(fixed[key], headers[key]);
});

test('attachment security, escaping, Unicode emoji and existing extended filenames survive', () => {
  const input = 'attachment; filename="图片;\\"样本😀.svg"; size=123';
  const fixed = safeResponseHeaders({ 'content-disposition': [input], 'X-Content-Type-Options': ['nosniff'] }).responseHeaders;
  assert.match(fixed['content-disposition'][0], /^attachment; filename=/);
  assert.match(fixed['content-disposition'][0], /; size=123;/);
  assert.equal(decodeURIComponent(fixed['content-disposition'][0].split("UTF-8''")[1]), '图片;"样本😀.svg');
  assert.deepEqual(fixed['X-Content-Type-Options'], ['nosniff']);
  const existing = safeResponseHeaders({ 'Content-Disposition': ["inline; filename=图片.png; filename*=UTF-8''correct.png"] }).responseHeaders;
  assert.equal(existing['Content-Disposition'][0], "inline; filename=\"__.png\"; filename*=UTF-8''correct.png");
});

test('ASCII, Latin-1, redirects, cookies, CORS and streaming headers need no changes', () => {
  const headers = { 'Content-Disposition': ['attachment; filename="café.png"'], 'Set-Cookie': ['a=1; HttpOnly', 'b=2; SameSite=Lax'], 'Access-Control-Allow-Origin': ['http://127.0.0.1:23110'], Location: ['/next'], 'Content-Type': ['text/event-stream'], 'Transfer-Encoding': ['chunked'] };
  assert.deepEqual(safeResponseHeaders(headers), {});
  assert.deepEqual(safeResponseHeaders(undefined), {});
});

test('unknown non-byte headers and malformed values fail closed rather than rewriting security semantics', () => {
  for (const headers of [
    { Location: ['/中文'] }, { 'Set-Cookie': ['key=中文'] }, { 'X-Name': ['😀'] }, { 'Content-Disposition': ['attachment; foo="中文"'] },
    { 'Content-Disposition': ['attachment; filename="中文"; filename="other"'] }, { 'Content-Disposition': ['filename="\ud800.png"'] },
    { 'X-Name': ['bad\r\nInjected: yes'] }, { '坏头': ['value'] }, { 'X-Name': 'value' },
  ]) {
    let listener;
    installResponseHeaderGuard({ webRequest: { onHeadersReceived: (_filter, fn) => { listener = fn; } } });
    let calls = 0;
    listener({ responseHeaders: headers }, result => { calls++; assert.deepEqual(result, { cancel: true }); });
    assert.equal(calls, 1);
  }
});

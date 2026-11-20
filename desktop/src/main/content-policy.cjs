'use strict';

function originOf(value) {
  try { return new URL(value).origin; } catch { return ''; }
}

function isSessionRequest(url, gatewayUrl) {
  try {
    const parsed = new URL(url);
    return parsed.origin === gatewayUrl && /^\/api\/session\/(open|heartbeat|close)$/.test(parsed.pathname);
  } catch { return false; }
}

function isAllowedNavigation(url, origins) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      && origins.has(parsed.origin);
  } catch { return false; }
}

function isExternalLink(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}

// Dedicated Electron session only: acknowledge legacy browser lifecycle traffic without
// touching the gateway's global browser session tracker. Cancelling these requests would
// trigger the canvas's gateway-down detector and its automatic reload loop.
function resolveGatewayAssetUrl(value, gatewayUrl) {
  if (typeof value !== 'string' || !value) return value;
  try {
    const resolved = new URL(value, `${gatewayUrl.replace(/\/+$/, '')}/`);
    return resolved.origin === gatewayUrl ? resolved.toString() : value;
  } catch { return value; }
}

function sessionResponse(request, gatewayUrl, canvasUrl) {
  if (!isSessionRequest(request.url, gatewayUrl) || !['POST', 'OPTIONS'].includes(request.method)) return null;
  const origin = request.headers.get('origin');
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (origin === canvasUrl || origin === gatewayUrl) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type, x-gateway-token';
    headers['access-control-allow-credentials'] = 'true';
  }
  return new Response(request.method === 'OPTIONS' ? null : JSON.stringify({ ok: true, desktop: true }),
    { status: request.method === 'OPTIONS' ? 204 : 200, headers });
}

// ComfyUI /view sends UTF-8 filenames directly in Content-Disposition. Electron
// decodes them to Unicode, then net.fetch's internal Headers.set throws outside
// its promise (ByteString). Rewrite BEFORE fetch constructs its Response, not in
// a catch handler. Keep the original filename via RFC 5987 and an ASCII fallback.
function normalizeMediaDisposition(value, requestFilename) {
  if (typeof value !== 'string') return value;
  // Electron's webRequest header event can expose a lossy conversion of the
  // UTF-8 name. /view's filename query is the lossless source in that case.
  const sourceName = typeof requestFilename === 'string' ? requestFilename.split(/[\\/]/).at(-1) : '';
  if (!/[^\x20-\x7e]/.test(value) && !/[^\x20-\x7e]/.test(sourceName)) return value;
  // Consume whole quoted parameters so a semicolon inside a filename cannot
  // impersonate filename* (or another filename parameter).
  const parameters = [...value.matchAll(/(?:^|;)\s*([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/g)];
  const match = parameters.find(param => param[1].toLowerCase() === 'filename');
  if (!match) return value.replace(/[^\x20-\x7e]+/gu, part => encodeURIComponent(part.toWellFormed()));
  const filename = (sourceName || (match[2] === undefined ? match[3].trim() : match[2].replace(/\\(.)/gs, '$1'))).toWellFormed();
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  // An upstream attachment must remain an attachment (including unsafe media).
  const type = /^\s*([!#$%&'*+.^_`|~\w-]+)\s*(?:;|$)/.exec(value)?.[1] || 'inline';
  const extended = parameters.find(param => param[1].toLowerCase() === 'filename*')?.[3]?.trim();
  const originalExtended = extended && /^[A-Za-z0-9-]+'[A-Za-z0-9-]*'(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-Fa-f]{2})+$/.test(extended) ? extended : `UTF-8''${encoded}`;
  return `${type}; filename="${fallback}"; filename*=${originalExtended}`;
}

function normalizeComfyMediaHeaders(details, comfyUrl) {
  let requestFilename;
  try {
    const url = new URL(details.url);
    // Never rewrite cloud, gateway, cookies, CORS, range, or unrelated headers.
    if (!comfyUrl || url.origin !== new URL(comfyUrl).origin || !/^\/(?:api\/)?view$/.test(url.pathname)) return null;
    requestFilename = url.searchParams.get('filename');
  } catch { return null; }
  let result = null;
  for (const [name, values] of Object.entries(details.responseHeaders || {})) {
    if (name.toLowerCase() !== 'content-disposition' || !Array.isArray(values)) continue;
    const normalized = values.map(value => normalizeMediaDisposition(value, requestFilename));
    if (normalized.some((value, index) => value !== values[index])) {
      result ||= { ...details.responseHeaders };
      result[name] = normalized;
    }
  }
  return result;
}

function installComfyMediaHeaderPolicy(contentSession, getComfyUrl) {
  contentSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = normalizeComfyMediaHeaders(details, getComfyUrl());
    callback(responseHeaders ? { responseHeaders } : {});
  });
}

module.exports = { originOf, isSessionRequest, isAllowedNavigation, isExternalLink, resolveGatewayAssetUrl, sessionResponse,
  normalizeMediaDisposition, normalizeComfyMediaHeaders, installComfyMediaHeaderPolicy };

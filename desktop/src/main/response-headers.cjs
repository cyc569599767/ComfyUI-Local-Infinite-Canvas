'use strict';

// Electron 41 session.fetch constructs undici Headers inside a native response
// event, before its Promise can reject. Chromium may decode UTF-8 header bytes
// (notably ComfyUI's filename="中文.png") to JS Unicode. Headers only accepts
// ByteString, so .catch() around fetch cannot contain that uncaught exception.
const NON_BYTE = /[^\u0000-\u00ff]/;
const BAD_VALUE = /[\u0000\r\n]/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function encodeFilename(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function byteSafeDisposition(value) {
  // Keep attachment/inline and other parameters intact: attachment is a
  // security boundary for HTML/SVG downloads, not merely a filename hint.
  const filename = /(^|;\s*)filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)(?=;|$)/ig;
  const matches = [...value.matchAll(filename)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const raw = match[2].trim();
  const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
  if (!NON_BYTE.test(name)) return null;
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const replacement = `${match[1]}filename="${fallback}"`;
  let result = value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length);
  if (NON_BYTE.test(result) || BAD_VALUE.test(result)) return null;
  // An existing RFC 5987 name has precedence; never replace it or add a second.
  if (!/(^|;)\s*filename\*\s*=/i.test(result)) result += `; filename*=UTF-8''${encodeFilename(name)}`;
  return result;
}

function safeResponseHeaders(responseHeaders) {
  if (!responseHeaders) return {};
  let changed = false;
  const next = {};
  for (const [name, values] of Object.entries(responseHeaders)) {
    if (!HEADER_NAME.test(name) || !Array.isArray(values)) return { cancel: true };
    const converted = [];
    for (const value of values) {
      if (typeof value !== 'string' || BAD_VALUE.test(value)) return { cancel: true };
      if (!NON_BYTE.test(value)) { converted.push(value); continue; }
      const safe = name.toLowerCase() === 'content-disposition' ? byteSafeDisposition(value) : null;
      // Do not guess encodings for cookies, CORS, redirects or security headers.
      // Reject that response instead of crashing the desktop's main process.
      if (safe === null) return { cancel: true };
      changed = true;
      converted.push(safe);
    }
    Object.defineProperty(next, name, { value: converted, enumerable: true, configurable: true, writable: true });
  }
  return changed ? { responseHeaders: next } : {};
}

function installResponseHeaderGuard(session) {
  // The http protocol handler forwards through this same session. Normalize
  // before Electron's fetch adapter sees headers, not after fetch has resolved.
  session.webRequest.onHeadersReceived({ urls: ['http://*/*'] }, (details, callback) => {
    let result;
    try { result = safeResponseHeaders(details.responseHeaders); }
    catch { result = { cancel: true }; }
    callback(result);
  });
}

module.exports = { safeResponseHeaders, installResponseHeaderGuard };

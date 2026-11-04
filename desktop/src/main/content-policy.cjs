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

module.exports = { originOf, isSessionRequest, isAllowedNavigation, isExternalLink, sessionResponse };

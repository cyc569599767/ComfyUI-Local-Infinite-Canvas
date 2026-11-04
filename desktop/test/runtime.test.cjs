'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getRuntimeInfo, isTrustedSender } = require('../src/main/runtime.cjs');

const rendererUrl = 'file:///desktop/src/renderer/index.html';
function fixture() {
  const mainFrame = { url: rendererUrl };
  const webContents = { mainFrame };
  return {
    window: { isDestroyed: () => false, webContents },
    event: { sender: webContents, senderFrame: mainFrame },
  };
}

test('runtime info exposes only the supported public fields', () => {
  const app = { getName: () => 'desktop', getVersion: () => '0.1.0' };
  assert.deepEqual(getRuntimeInfo(app, {
    electron: '41.0.3', node: '24.14.0', chrome: '146.0.0.0', secret: 'not exposed',
  }, 'win32'), {
    name: 'desktop', version: '0.1.0', electron: '41.0.3',
    node: '24.14.0', chrome: '146.0.0.0', platform: 'win32',
  });
});

test('IPC accepts our local main frame', () => {
  const { event, window } = fixture();
  assert.equal(isTrustedSender(event, window, rendererUrl), true);
});

test('IPC rejects other windows and child frames, even with the same URL', () => {
  const { event, window } = fixture();
  assert.equal(isTrustedSender({ ...event, sender: {} }, window, rendererUrl), false);
  assert.equal(isTrustedSender({ ...event, senderFrame: { url: rendererUrl } }, window, rendererUrl), false);
  assert.equal(isTrustedSender({ ...event, senderFrame: null }, window, rendererUrl), false);
});

test('IPC rejects navigation to a different document', () => {
  const { event, window } = fixture();
  event.senderFrame.url = 'https://example.com/';
  assert.equal(isTrustedSender(event, window, rendererUrl), false);
});

test('IPC rejects absent or destroyed windows', () => {
  const { event, window } = fixture();
  assert.equal(isTrustedSender(event, null, rendererUrl), false);
  window.isDestroyed = () => true;
  assert.equal(isTrustedSender(event, window, rendererUrl), false);
});

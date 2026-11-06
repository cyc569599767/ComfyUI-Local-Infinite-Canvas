'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('desktop tabs follow the requested order and preserve their service routes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const tabs = [...html.matchAll(/<button\b([^>]*\bdata-page="([^"]+)"[^>]*)>([^<]*)<\/button>/g)]
    .map(([, attributes, page, label]) => ({ page, label: label.trim(), disabled: /\bdisabled\b/.test(attributes), active: /class="active"/.test(attributes) }));
  assert.deepEqual(tabs, [
    { page: 'canvas', label: '无界工作台', disabled: true, active: false },
    { page: 'comfy', label: 'ComfyUI', disabled: true, active: false },
    { page: 'dashboard', label: '服务面板', disabled: false, active: true },
    { page: 'gateway', label: '网关管理', disabled: true, active: false },
  ]);
});

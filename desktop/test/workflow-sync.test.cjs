'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'comfyui-gateway/workflows');
const runtime = path.join(root, 'desktop/.build/runtime/comfyui-gateway/workflows');
function files(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...files(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(relative);
  }
  return result.sort();
}
function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('desktop runtime contains every current Web workflow byte-for-byte', () => {
  assert.equal(fs.existsSync(source), true, 'Web workflow source directory is missing');
  assert.equal(fs.existsSync(runtime), true, 'desktop runtime workflow directory is missing; run npm run build first');
  const sourceFiles = files(source);
  const runtimeFiles = files(runtime);
  assert.deepEqual(runtimeFiles, sourceFiles, 'workflow filename set drifted between Web and desktop runtime');
  for (const relative of sourceFiles) {
    assert.equal(digest(path.join(runtime, relative)), digest(path.join(source, relative)), `workflow content drift: ${relative}`);
  }
  const registry = JSON.parse(fs.readFileSync(path.join(source, 'registry.json'), 'utf8'));
  assert.equal(Array.isArray(registry.workflows), true);
  const ids = registry.workflows.map(item => item?.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'workflow registry contains duplicate IDs');
  for (const item of registry.workflows) {
    assert.equal(typeof item.file, 'string', `workflow ${item.id} has no file`);
    assert.equal(sourceFiles.includes(item.file), true, `workflow ${item.id} references missing ${item.file}`);
    for (const [mode, variant] of Object.entries(item.variants || {})) {
      assert.equal(typeof variant?.file, 'string', `workflow ${item.id} variant ${mode} has no file`);
      assert.equal(sourceFiles.includes(variant.file), true, `workflow ${item.id} variant ${mode} references missing ${variant.file}`);
    }
    for (const [key, binding] of Object.entries(item.bindings || {})) {
      assert.equal(typeof binding?.node, 'string', `workflow ${item.id} binding ${key} has no node`);
      assert.equal(typeof binding?.input, 'string', `workflow ${item.id} binding ${key} has no input`);
    }
  }
});

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const integrationTest = args.includes('--integration-smoke') || args.includes('--managed-integration');
const smokeTest = args.includes('--smoke-test') || integrationTest;
const env = { ...process.env };
// Editors and other Electron hosts can inherit this; a desktop launch must not.
delete env.ELECTRON_RUN_AS_NODE;
const testProfile = smokeTest ? fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-desktop-smoke-')) : null;
if (testProfile) args.push(`--user-data-dir=${testProfile}`);

const child = spawn(require('electron'), [root, ...args], {
  cwd: root,
  stdio: 'inherit',
  env,
});
let timedOut = false;
const timer = smokeTest ? setTimeout(() => {
  timedOut = true;
  console.error('[desktop] Smoke test exceeded its time budget.');
  child.kill();
}, integrationTest ? 60000 : 30000) : null;

child.on('error', (error) => {
  console.error('[desktop] Unable to launch Electron:', error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  if (timer) clearTimeout(timer);
  process.exitCode = timedOut ? 1 : (process.exitCode || code || (code === 0 ? 0 : 1));
  if (testProfile) {
    try {
      fs.rmSync(testProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      console.error(`[desktop] Temporary test profile remains at ${testProfile}: ${error.message}`);
      process.exitCode = 1;
    }
  }
});

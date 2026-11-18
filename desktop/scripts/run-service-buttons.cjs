'use strict';
// 以真实 Electron 运行按钮状态验证（清掉 ELECTRON_RUN_AS_NODE）。
const { spawn } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(require('electron'), [path.join(__dirname, 'test-service-buttons.cjs')], {
  env, stdio: 'inherit', windowsHide: true,
});

const timer = setTimeout(() => {
  child.kill();
  console.error('Service button check exceeded deadline');
  process.exitCode = 1;
}, 60000);

child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0) process.exitCode = 1;
});
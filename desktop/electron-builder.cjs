'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { ELECTRON_VERSION, readJson, verifyRuntime } = require('./scripts/verify-runtime.cjs');

// This distribution is unsigned unless the release operator supplies a valid
// CSC_LINK / WIN_CSC_LINK certificate (and its password) to electron-builder.
// No certificate, password, or machine-local configuration belongs in this file.
module.exports = {
  appId: 'com.comfycanvas.desktop',
  productName: 'Comfy Canvas',
  executableName: 'ComfyCanvas',
  electronVersion: ELECTRON_VERSION,
  electronDist: path.join(__dirname, 'node_modules/electron/dist'),
  asar: true,
  npmRebuild: false,
  files: ['src/**/*', 'package.json'],
  extraResources: [{ from: '.build/runtime', to: 'runtime', filter: ['**/*'] }],
  directories: { output: 'release' },
  icon: '.build/app-icon.ico',
  artifactName: 'ComfyCanvas-${version}-${arch}-setup.${ext}',
  publish: null,
  forceCodeSigning: false,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: '.build/app-icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false,
  },
  beforePack: async () => {
    const result = verifyRuntime(path.join(__dirname, '.build/runtime'));
    if (result.buildVersion !== readJson(path.join(__dirname, 'package.json')).version) throw new Error('Runtime staging version is stale; rebuild runtime');
    const version = fs.readFileSync(path.join(__dirname, 'node_modules/electron/dist/version'), 'utf8').trim().replace(/^v/, '');
    if (version !== ELECTRON_VERSION) throw new Error(`Local Electron distribution must be ${ELECTRON_VERSION}`);
    if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) console.warn('No signing certificate configured: this Comfy Canvas build is UNSIGNED (SmartScreen warnings are expected).');
  },
};

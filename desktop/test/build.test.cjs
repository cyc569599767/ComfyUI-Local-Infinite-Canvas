'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../scripts/build-runtime.cjs');
const verify = require('../scripts/verify-runtime.cjs');
const builder = require('../electron-builder.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-desktop-build-test-'));
  t.after(() => {
    // Never clean a computed arbitrary path: confirm the exact generated fixture.
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^comfy-desktop-build-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function put(root, relative, value = 'fixture\n') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function packageFixture(root) {
  const pkg = { name: 'fixture-gateway', version: '1.0.0', dependencies: { production: '^1.0.0' }, devDependencies: { development: '^2.0.0' } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': pkg,
    'node_modules/production': { version: '1.0.1', license: 'MIT', integrity: 'sha512-fixture' },
    'node_modules/development': { version: '2.0.0', dev: true },
  } };
  put(root, 'package.json', pkg);
  put(root, 'package-lock.json', lock);
  put(root, 'node_modules/production/package.json', { name: 'production', version: '1.0.1', license: 'MIT' });
  put(root, 'node_modules/production/LICENSE', 'MIT fixture license\nCopyright fixture\n');
  put(root, 'node_modules/production/LICENSE-extra.txt', 'Extra fixture terms\n');
  return { pkg, lock };
}

function runtimeFixture(t) {
  const root = fixture(t);
  for (const file of verify.REQUIRED_FILES) put(root, file);
  for (const tree of verify.SOURCE_TREES) put(root, `${verify.GATEWAY}/${tree}/fixture.txt`);
  put(root, `${verify.GATEWAY}/resources/nodes/unpacked/example/__init__.py`, '# fixture');
  put(root, 'VERSION', 'v0.24.6\n');
  put(root, `${verify.RENDERER}/plugins/index.json`, ['/plugins/comfyui-lora.js']);
  packageFixture(path.join(root, verify.GATEWAY));
  const options = { buildVersion: '0.1.0', sourceVersion: 'v0.24.6', sourceFiles: { 'desktop/package.json': { sha256: 'a'.repeat(64), size: 42 } } };
  verify.writeManifest(root, options);
  return { root, options };
}

test('staging is exclusively desktop/.build/runtime and rebuild preserves source dist and siblings', (t) => {
  const root = fixture(t);
  const layout = build.getLayout(root);
  put(root, 'infinite-canvas/web/dist/keep.txt', 'source dist');
  put(root, 'desktop/.build/unrelated.txt', 'keep');
  put(root, 'desktop/.build/runtime/old.txt', 'old staging');
  assert.equal(build.assertStagingPath(root, layout.staging), layout.staging);
  for (const wrong of [root, path.join(root, 'desktop/.build'), path.join(root, 'infinite-canvas/web/dist'), `${layout.staging}-other`, 'desktop/.build/runtime']) {
    assert.throws(() => build.resetStaging(root, wrong), /Only|absolute/);
  }
  build.resetStaging(root, layout.staging);
  assert.deepEqual(fs.readdirSync(layout.staging), []);
  assert.equal(fs.readFileSync(path.join(root, 'infinite-canvas/web/dist/keep.txt'), 'utf8'), 'source dist');
  assert.equal(fs.readFileSync(path.join(root, 'desktop/.build/unrelated.txt'), 'utf8'), 'keep');
});

test('staging junction/symlink escape is rejected without following it', (t) => {
  const root = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, 'desktop'));
  try { fs.symlinkSync(outside, path.join(root, 'desktop/.build'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Host does not allow symlink fixtures'); throw error; }
  put(root, 'outside/keep.txt');
  assert.throws(() => build.resetStaging(root, build.getLayout(root).staging), /links|junctions/);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
});

test('renderer clears inherited VITE keys without modifying parent env', () => {
  const original = { PATH: 'fixture', VITE_SECRET: 'never-inline', vite_lower: 'never-inline', VITE_LOCAL_GATEWAY_URL: 'http://bad', KEEP: 'yes' };
  assert.deepEqual(build.rendererEnvironment(original), { PATH: 'fixture', KEEP: 'yes', VITE_LOCAL_ONLY: 'true', VITE_LOCAL_GATEWAY_URL: '' });
  assert.equal(original.VITE_SECRET, 'never-inline');
});

test('renderer uses Node and the repository Vite with an absolute staging outDir', (t) => {
  const root = fixture(t);
  const layout = build.getLayout(root);
  put(root, 'infinite-canvas/web/node_modules/vite/bin/vite.js');
  const spec = build.rendererCommand(layout, { VITE_BAD: 'secret' });
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, [path.join(layout.web, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', path.join(layout.staging, verify.RENDERER), '--emptyOutDir']);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.stdio, 'inherit');
  assert.equal(spec.options.cwd, layout.web);
  assert.notEqual(spec.args[3], path.join(layout.web, 'dist'));
});

test('release renderer rejects Vite dotenv inputs instead of leaking settings', (t) => {
  const root = fixture(t);
  build.assertNoRendererEnvFiles(root);
  put(root, '.env.production.local', 'VITE_SECRET=private');
  assert.throws(() => build.assertNoRendererEnvFiles(root), /\.env files/);
});

test('npm install resolves a JS entry and uses argument array with scripts disabled', (t) => {
  const root = fixture(t);
  const npm = put(root, 'tools with spaces & chars/npm-cli.js');
  assert.equal(build.resolveNpmCli({ npm_execpath: npm }, path.join(root, 'node.exe')), fs.realpathSync(npm));
  const spec = build.npmInstallCommand(build.getLayout(root), npm, { npm_config_ignore_scripts: 'false', npm_config_include: 'dev', NPM_CONFIG_DRY_RUN: 'true' });
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(spec.options.stdio, 'inherit');
  assert.equal(spec.options.shell, false);
  assert.deepEqual(spec.options.env, {});
  assert.throws(() => build.npmInstallCommand(build.getLayout(root), 'npm.cmd'), /resolved absolute/);
});

test('subprocess errors, signals and non-zero statuses stop the build', () => {
  const spec = { command: 'fixture', args: [], options: {} };
  assert.throws(() => build.runCommand(spec, () => ({ status: 1 })), /failed/);
  assert.throws(() => build.runCommand(spec, () => ({ status: null, signal: 'SIGTERM' })), /SIGTERM/);
  assert.throws(() => build.runCommand(spec, () => ({ error: new Error('spawn refused') })), /spawn refused/);
  build.runCommand(spec, () => ({ status: 0 }));
});

test('source-copy exclusion protects environments, node_modules, data and caches', () => {
  for (const file of ['launcher/config.json', 'comfyui-gateway/data/config.json', 'comfyui-gateway/resources/nodes/.env.local', 'comfyui-gateway/resources/nodes/__pycache__/x.pyc', 'comfyui-gateway/resources/nodes/node_modules/pkg/index.js', 'comfyui-gateway/resources/nodes/.git/config']) {
    if (file === 'launcher/config.json') assert.throws(() => verify.assertAllowedRuntimeFile(file), /allowlist/);
    else assert.equal(build.shouldCopySource(file), false, file);
  }
  assert.equal(build.shouldCopySource('comfyui-gateway/resources/nodes/example/src/models/network.py'), true);
});

test('runtime rejects non-allowlisted data and large weights but permits reviewed small tensors', () => {
  for (const file of ['../escape', '/absolute', 'C:/absolute', 'x\\y', 'x/../y', 'comfyui-gateway/resources/bundled/model.safetensors', 'comfyui-gateway/resources/loras/x.safetensors', 'comfyui-gateway/resources/nodes/foo/model.gguf', 'infinite-canvas/web/node_modules/react/index.js', 'comfyui-gateway/test/check.js', 'desktop/test/check.js', 'comfyui-gateway/src/.env', 'launcher/launcher.log']) {
    assert.throws(() => verify.assertAllowedRuntimeFile(file), undefined, file);
  }
  for (const file of verify.SMALL_TENSORS) assert.equal(verify.assertAllowedRuntimeFile(file), file);
  verify.assertAllowedRuntimeFile('comfyui-gateway/resources/nodes/TE-Speed-MOSS.zip');
});

test('lock validation rejects mismatched root, traversal and local/link dependencies', (t) => {
  const { pkg, lock } = packageFixture(fixture(t));
  verify.validateLock(pkg, lock);
  assert.throws(() => verify.validateLock({ ...pkg, version: '9.0.0' }, lock), /identity/);
  assert.throws(() => verify.validateLock({ ...pkg, dependencies: {} }, lock), /dependencies/);
  const local = structuredClone(lock);
  local.packages['node_modules/production'].resolved = 'file:../private';
  assert.throws(() => verify.validateLock(pkg, local), /local dependency/);
  const linked = structuredClone(lock);
  linked.packages['node_modules/production'].link = true;
  assert.throws(() => verify.validateLock(pkg, linked), /linked/);
  const escape = structuredClone(lock);
  escape.packages['node_modules/../../escape'] = { version: '1.0.0' };
  assert.throws(() => verify.validateLock(pkg, escape), /Unsafe/);
});

test('installed production dependencies must match lock and exclude dev/extraneous', (t) => {
  const root = fixture(t);
  packageFixture(root);
  assert.equal(verify.validateInstalledDependencies(root).length, 1);
  put(root, 'node_modules/production/package.json', { name: 'production', version: '9.0.0' });
  assert.throws(() => verify.validateInstalledDependencies(root), /differs from lock/);
  put(root, 'node_modules/production/package.json', { name: 'production', version: '1.0.1' });
  put(root, 'node_modules/development/package.json', { name: 'development', version: '2.0.0' });
  assert.throws(() => verify.validateInstalledDependencies(root), /dev dependency/);
});

test('all dependency LICENSE files, versions and declared licenses are collected without host paths', (t) => {
  const root = fixture(t);
  packageFixture(root);
  const licenses = build.collectDependencyLicenses(root, 'gateway', { productionOnlyInstall: true });
  assert.equal(licenses.length, 1);
  assert.equal(licenses[0].name, 'production');
  assert.equal(licenses[0].version, '1.0.1');
  assert.equal(licenses[0].license, 'MIT');
  assert.equal(licenses[0].texts.length, 2);
  const text = build.renderDependencyLicenses(licenses);
  assert.match(text, /MIT fixture license/);
  assert.match(text, /Extra fixture terms/);
  assert.match(text, /Chromium/);
  assert.ok(!text.includes(root));
});

test('renderer license selection ignores dev packages and Vite cache, not optional installed packages', (t) => {
  const root = fixture(t);
  packageFixture(root);
  put(root, 'node_modules/.vite-temp/cache.js', 'temporary');
  put(root, 'node_modules/development/package.json', { name: 'development', version: '2.0.0' });
  assert.equal(build.collectDependencyLicenses(root, 'renderer').length, 1);
});

test('manifest hashes all regular payload files, excludes itself and contains only relative provenance', (t) => {
  const { root, options } = runtimeFixture(t);
  const manifest = verify.readJson(path.join(root, verify.MANIFEST));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.buildVersion, '0.1.0');
  assert.equal(manifest.electronVersion, '41.0.3');
  assert.equal(manifest.sourceVersion, 'v0.24.6');
  assert.equal(manifest.files[verify.MANIFEST], undefined);
  assert.equal(Object.keys(manifest.files).length + 1, verify.listRegularFiles(root).length);
  assert.ok(manifest.includedAssets.some((entry) => entry.includes('preview VAE')));
  assert.ok(manifest.omittedAssets.some((entry) => entry.includes('Large generation')));
  assert.ok(!JSON.stringify(manifest).includes(root));
  assert.deepEqual(verify.createManifest(root, options), manifest);
  const summary = verify.verifyRuntime(root);
  assert.equal(summary.productionDependencies, 1);
  assert.equal(summary.buildVersion, '0.1.0');
});

test('verification catches payload tampering, extra files and missing requirements', (t) => {
  const { root, options } = runtimeFixture(t);
  put(root, 'launcher/start.mjs', 'tampered');
  assert.throws(() => verify.verifyRuntime(root), /hash mismatch/);
  verify.writeManifest(root, options);
  put(root, `${verify.GATEWAY}/src/extra.js`, 'unmanifested');
  assert.throws(() => verify.verifyRuntime(root), /file set/);
  verify.writeManifest(root, options);
  const file = path.join(root, 'launcher/desktop-protocol.mjs');
  assert.equal(path.dirname(file), path.join(root, 'launcher'));
  fs.unlinkSync(file);
  assert.throws(() => verify.verifyRuntime(root), /Missing required/);
});

test('verification rejects extra manifest metadata, absolute provenance and version drift', (t) => {
  const { root, options } = runtimeFixture(t);
  const manifest = verify.readJson(path.join(root, verify.MANIFEST));
  put(root, verify.MANIFEST, { ...manifest, environment: { SECRET: 'bad' } });
  assert.throws(() => verify.verifyRuntime(root), /schema/);
  put(root, verify.MANIFEST, { ...manifest, sourceFiles: { 'C:/private/source': { sha256: 'a'.repeat(64), size: 1 } } });
  assert.throws(() => verify.verifyRuntime(root), /Unsafe/);
  verify.writeManifest(root, { ...options, sourceVersion: 'v1.0.0' });
  assert.throws(() => verify.verifyRuntime(root), /source version/);
});

test('published plugin registry omits source-editing assistant without editing source registry', (t) => {
  const { root, options } = runtimeFixture(t);
  put(root, `${verify.RENDERER}/plugins/index.json`, ['/plugins/canvas-assistant.js', '/plugins/comfyui-lora.js']);
  verify.writeManifest(root, options);
  assert.throws(() => verify.verifyRuntime(root), /assistant/);
  build.filterPublishedPlugins(root);
  assert.deepEqual(verify.readJson(path.join(root, verify.RENDERER, 'plugins/index.json')), ['/plugins/comfyui-lora.js']);
  verify.writeManifest(root, options);
  verify.verifyRuntime(root);
});

test('builder packages only application src and verified external runtime with exact Electron and safe NSIS defaults', () => {
  assert.equal(builder.appId, 'com.comfycanvas.desktop');
  assert.equal(builder.productName, 'Comfy Canvas');
  assert.equal(builder.executableName, 'ComfyCanvas');
  assert.equal(builder.electronVersion, '41.0.3');
  assert.equal(builder.asar, true);
  assert.deepEqual(builder.files, ['src/**/*', 'package.json']);
  assert.deepEqual(builder.extraResources, [{ from: '.build/runtime', to: 'runtime', filter: ['**/*'] }]);
  assert.ok(path.isAbsolute(builder.electronDist));
  assert.match(builder.electronDist, /node_modules[\\/]electron[\\/]dist$/);
  assert.deepEqual(builder.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(builder.nsis.oneClick, false);
  assert.equal(builder.nsis.perMachine, false);
  assert.equal(builder.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(builder.nsis.createDesktopShortcut, true);
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  assert.equal(builder.publish, null);
  assert.equal(builder.forceCodeSigning, false);
  assert.equal(builder.artifactName, 'ComfyCanvas-${version}-${arch}-setup.${ext}');
});

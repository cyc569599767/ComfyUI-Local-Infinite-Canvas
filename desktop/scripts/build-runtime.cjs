'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ELECTRON_VERSION, GATEWAY, RENDERER, SOURCE_TREES, LEGAL_NAME, REQUIRED_FILES,
  readJson, assertRelative, assertNoLinks, listRegularFiles, digestFile,
  isPrivateOrGenerated, assertAllowedRuntimeFile, validateLock, installedPackages,
  validateInstalledDependencies, writeManifest, verifyRuntime,
} = require('./verify-runtime.cjs');

function getLayout(repoRoot = path.resolve(__dirname, '../..')) {
  const root = path.resolve(repoRoot);
  return {
    root, desktop: path.join(root, 'desktop'), web: path.join(root, 'infinite-canvas/web'),
    gateway: path.join(root, GATEWAY), staging: path.join(root, 'desktop/.build/runtime'),
    icon: path.join(root, 'desktop/.build/app-icon.ico'),
    lock: path.join(root, 'desktop/.build/runtime-build.lock'),
  };
}

// The build owns exactly this directory, never a caller-selected output directory.
function assertStagingPath(repoRoot, target) {
  if (!path.isAbsolute(target)) throw new Error('Staging must be an absolute path');
  const layout = getLayout(repoRoot);
  if (path.resolve(target) !== layout.staging) throw new Error('Only desktop/.build/runtime may be cleared');
  assertNoLinks(layout.root, layout.staging);
  return layout.staging;
}

function resetStaging(repoRoot, target) {
  const approved = assertStagingPath(repoRoot, target);
  // Checked again immediately before the destructive operation; no arbitrary rm helper.
  assertStagingPath(repoRoot, approved);
  fs.rmSync(approved, { recursive: true, force: true });
  fs.mkdirSync(approved, { recursive: true });
  return approved;
}

function runtimeDestination(layout, relative) {
  assertRelative(relative);
  assertAllowedRuntimeFile(relative);
  assertStagingPath(layout.root, layout.staging);
  const destination = path.resolve(layout.staging, relative);
  assertNoLinks(layout.staging, destination);
  return destination;
}

function copySourceFile(layout, relative, sourceFiles) {
  assertRelative(relative);
  const source = assertNoLinks(layout.root, path.join(layout.root, relative));
  if (!fs.lstatSync(source).isFile()) throw new Error(`Expected source file: ${relative}`);
  const destination = runtimeDestination(layout, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  sourceFiles[relative] = digestFile(source);
}

function shouldCopySource(relative) {
  if (isPrivateOrGenerated(relative)) return false;
  const parts = relative.split('/');
  return !parts.some((part) => ['node_modules', '.DS_Store', 'Thumbs.db'].includes(part));
}

function copySourceTree(layout, relative, sourceFiles) {
  const source = assertNoLinks(layout.root, path.join(layout.root, relative));
  if (!fs.lstatSync(source).isDirectory()) throw new Error(`Expected source directory: ${relative}`);
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (!shouldCopySource(name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Source symlink/junction refused: ${name}`);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), name);
      else if (entry.isFile()) copySourceFile(layout, name, sourceFiles);
      else throw new Error(`Non-regular source entry: ${name}`);
    }
  }
  walk(source, relative);
}

function rendererEnvironment(environment = process.env) {
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^VITE_/i.test(key)));
  // Do not serialize this object: it may contain registry credentials or local secrets.
  clean.VITE_LOCAL_ONLY = 'true';
  clean.VITE_LOCAL_GATEWAY_URL = '';
  return clean;
}

function assertNoRendererEnvFiles(web) {
  // Vite itself loads .env files even after process.env is cleaned. Fail rather than
  // silently inline machine-local settings, or edit anybody's source environment.
  const envFiles = fs.readdirSync(web).filter((name) => name === '.env' || name.startsWith('.env.'));
  if (envFiles.length) throw new Error('Renderer .env files are not allowed for a release build; use a clean source checkout');
}

function rendererCommand(layout, environment = process.env) {
  assertStagingPath(layout.root, layout.staging);
  const outDir = path.join(layout.staging, RENDERER);
  assertNoLinks(layout.root, outDir);
  const vite = path.join(layout.web, 'node_modules/vite/bin/vite.js');
  if (!fs.existsSync(vite)) throw new Error('Install locked renderer dependencies before building (Vite is missing)');
  return {
    command: process.execPath,
    args: [vite, 'build', '--outDir', outDir, '--emptyOutDir'],
    options: { cwd: layout.web, env: rendererEnvironment(environment), stdio: 'inherit', shell: false, windowsHide: true },
  };
}

function resolveNpmCli(environment = process.env, execPath = process.execPath) {
  const candidates = [];
  if (environment.npm_execpath && path.isAbsolute(environment.npm_execpath) && /(?:^|[\\/])npm-cli\.js$/i.test(environment.npm_execpath)) candidates.push(environment.npm_execpath);
  for (const executable of [execPath, fs.existsSync(execPath) ? fs.realpathSync(execPath) : execPath]) {
    const directory = path.dirname(executable);
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    candidates.push(path.resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const directory of pathValue.split(path.delimiter)) {
    const absolute = directory.replace(/^"|"$/g, '');
    if (!path.isAbsolute(absolute)) continue;
    candidates.push(path.join(absolute, 'node_modules/npm/bin/npm-cli.js'));
    for (const executable of ['npm', 'npm.cmd', 'npm.ps1']) {
      const shim = path.join(absolute, executable);
      if (fs.existsSync(shim)) {
        const resolved = fs.realpathSync(shim);
        if (/npm-cli\.js$/i.test(resolved)) candidates.push(resolved);
        candidates.push(path.join(path.dirname(resolved), 'node_modules/npm/bin/npm-cli.js'));
      }
    }
  }
  const selected = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!selected) throw new Error('Cannot resolve npm-cli.js; run via npm or install Node.js with npm');
  return fs.realpathSync(selected);
}

function npmInstallCommand(layout, npmCli, environment = process.env) {
  assertStagingPath(layout.root, layout.staging);
  if (!path.isAbsolute(npmCli) || !/npm-cli\.js$/i.test(npmCli)) throw new Error('npm must be a resolved absolute npm-cli.js path');
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^npm_config_(?:omit|include|production|only|ignore_scripts|package_lock|dry_run|global|prefix|workspace|workspaces)$/i.test(key)));
  return {
    command: process.execPath,
    args: [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    options: { cwd: path.join(layout.staging, GATEWAY), env, stdio: 'inherit', shell: false, windowsHide: true },
  };
}

function runCommand(spec, run = spawnSync) {
  const result = run(spec.command, spec.args, spec.options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build subprocess failed (${result.signal || result.status})`);
}

function captureRendererSources(layout, sourceFiles) {
  const prefixes = ['src', 'public'];
  const selected = fs.readdirSync(layout.web).filter((name) => /^(?:package(?:-lock)?\.json|index\.html|vite\.config\.[^/]+|tsconfig[^/]*\.json|postcss\.config\.[^/]+|components\.json)$/.test(name));
  for (const tree of prefixes) {
    for (const file of listRegularFiles(path.join(layout.web, tree))) selected.push(`${tree}/${file}`);
  }
  for (const file of selected) {
    if (!shouldCopySource(file)) continue;
    const relative = `infinite-canvas/web/${file}`;
    sourceFiles[relative] = digestFile(path.join(layout.root, relative));
  }
  // These are imported by vite.config.ts; do not copy the changelog into runtime.
  for (const relative of ['VERSION', 'CHANGELOG.md', 'desktop/package.json']) sourceFiles[relative] = digestFile(path.join(layout.root, relative));
}

function legalFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGAL_NAME.test(entry.name)).map((entry) => entry.name).sort();
}

function licenseTexts(directory) {
  const result = [];
  function walk(current, prefix = '', inLicenseDir = false) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Dependency license path is a symlink: ${relative}`);
      if (entry.isDirectory() && /^(?:licenses?|licences?)$/i.test(entry.name)) walk(path.join(current, entry.name), relative, true);
      else if (entry.isFile() && (inLicenseDir || /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(entry.name))) {
        result.push({ path: relative, text: fs.readFileSync(path.join(current, entry.name), 'utf8') });
      }
    }
  }
  walk(directory);
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function collectDependencyLicenses(packageRoot, scope, { productionOnlyInstall = false } = {}) {
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  const lock = validateLock(pkg, readJson(path.join(packageRoot, 'package-lock.json')));
  const installed = productionOnlyInstall ? validateInstalledDependencies(packageRoot) : Object.entries(lock.packages)
    .filter(([relative, entry]) => relative && entry.dev !== true)
    .flatMap(([relative]) => {
      const directory = assertNoLinks(packageRoot, path.join(packageRoot, relative));
      const file = path.join(directory, 'package.json');
      return fs.existsSync(file) ? [{ relative, directory, packageJson: readJson(file) }] : [];
    });
  const byPath = new Map(installed.map((entry) => [entry.relative, entry]));
  const result = [];
  for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!relative || entry.dev === true) continue;
    const dependency = byPath.get(relative);
    if (!dependency) {
      if (entry.optional) continue; // Platform-optional packages not present are not distributed.
      throw new Error(`Missing renderer production dependency: ${relative}`);
    }
    if (dependency.packageJson.version !== entry.version) throw new Error(`Dependency version differs from lock: ${relative}`);
    const license = dependency.packageJson.license || dependency.packageJson.licenses || entry.license || 'NOT DECLARED';
    result.push({
      scope, path: relative, name: dependency.packageJson.name, version: dependency.packageJson.version,
      license: typeof license === 'string' ? license : JSON.stringify(license),
      texts: licenseTexts(dependency.directory),
    });
  }
  return result;
}

function renderDependencyLicenses(dependencies) {
  const parts = [
    'Comfy Canvas - production npm dependency notices',
    'Gateway dependencies are installed from its lock with lifecycle scripts disabled.',
    'Renderer production dependencies are conservatively listed from its lock; the renderer is bundled, not its node_modules.',
    'Packages absent due to platform-optional selection are not distributed.',
    'Electron includes its own Electron and Chromium license notices in the Electron distribution.',
    '',
  ];
  for (const dependency of dependencies) {
    parts.push('='.repeat(78), `${dependency.name}@${dependency.version}`, `Scope: ${dependency.scope}`, `Package: ${dependency.path}`, `License: ${dependency.license}`, '');
    if (!dependency.texts.length) parts.push('No LICENSE/COPYING/NOTICE file supplied by this installed package; see declared license above.');
    for (const license of dependency.texts) parts.push(`--- ${license.path} ---`, license.text, '');
  }
  return `${parts.join('\n')}\n`;
}

function filterPublishedPlugins(staging) {
  const file = path.join(staging, RENDERER, 'plugins/index.json');
  const plugins = readJson(file);
  if (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== 'string')) throw new Error('Unexpected renderer plugin registry format');
  fs.writeFileSync(file, `${JSON.stringify(plugins.filter((entry) => !/canvas-assistant\.js/i.test(entry)), null, 2)}\n`);
}

function buildRuntime(repoRoot = path.resolve(__dirname, '../..')) {
  const layout = getLayout(repoRoot);
  const desktopPackage = readJson(path.join(layout.desktop, 'package.json'));
  if (desktopPackage.devDependencies?.electron !== ELECTRON_VERSION) throw new Error(`Desktop must pin Electron ${ELECTRON_VERSION}`);
  assertNoRendererEnvFiles(layout.web);
  validateLock(readJson(path.join(layout.gateway, 'package.json')), readJson(path.join(layout.gateway, 'package-lock.json')));
  const npmCli = resolveNpmCli();
  const renderer = rendererCommand(layout);
  assertNoLinks(layout.root, path.dirname(layout.staging));
  fs.mkdirSync(path.dirname(layout.staging), { recursive: true });
  let lockFd;
  try { lockFd = fs.openSync(layout.lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another runtime build owns staging (or a stale desktop/.build/runtime-build.lock needs manual review)');
    throw error;
  }
  try {
    fs.writeFileSync(lockFd, 'Exclusive Comfy Canvas runtime build. Remove only after confirming no build is running.\n');
    resetStaging(layout.root, layout.staging);
    const sourceFiles = {};
    for (const tree of SOURCE_TREES) copySourceTree(layout, `${GATEWAY}/${tree}`, sourceFiles);
    for (const tree of ['nodes', 'vae_approx']) copySourceTree(layout, `${GATEWAY}/resources/${tree}`, sourceFiles);
    for (const relative of [
      `${GATEWAY}/package.json`, `${GATEWAY}/package-lock.json`, `${GATEWAY}/workflow-baseline.json`, `${GATEWAY}/resources/index.json`,
      'launcher/start.mjs', 'launcher/bootstrap-nodes.mjs', 'launcher/desktop-protocol.mjs', 'VERSION',
      ...legalFiles(layout.root), ...legalFiles(path.join(layout.root, 'infinite-canvas')).map((file) => `infinite-canvas/${file}`),
    ]) copySourceFile(layout, relative, sourceFiles);
    if (fs.existsSync(path.join(layout.root, 'infinite-canvas/VERSION'))) copySourceFile(layout, 'infinite-canvas/VERSION', sourceFiles);
    captureRendererSources(layout, sourceFiles);
    runCommand(renderer);
    filterPublishedPlugins(layout.staging);
    runCommand(npmInstallCommand(layout, npmCli));
    const dependencies = [
      ...collectDependencyLicenses(path.join(layout.staging, GATEWAY), 'gateway', { productionOnlyInstall: true }),
      ...collectDependencyLicenses(layout.web, 'renderer'),
    ];
    fs.writeFileSync(runtimeDestination(layout, 'DEPENDENCY-LICENSES.txt'), renderDependencyLicenses(dependencies));
    // Icon is the only allowed build output outside runtime; never copy launcher config.
    const iconSource = assertNoLinks(layout.root, path.join(layout.root, 'launcher/app-icon.ico'));
    assertNoLinks(layout.root, layout.icon);
    fs.copyFileSync(iconSource, layout.icon);
    sourceFiles['launcher/app-icon.ico'] = digestFile(iconSource);
    writeManifest(layout.staging, { buildVersion: desktopPackage.version, sourceVersion: fs.readFileSync(path.join(layout.root, 'VERSION'), 'utf8').trim(), sourceFiles });
    const result = verifyRuntime(layout.staging);
    console.log(`Runtime ready: ${JSON.stringify(result)}. Existing infinite-canvas/web/dist was not modified.`);
    return result;
  } finally {
    fs.closeSync(lockFd);
    // Only unlink the one lock this invocation successfully created, not a directory.
    if (layout.lock !== path.join(layout.root, 'desktop/.build/runtime-build.lock')) throw new Error('Unexpected build lock path');
    assertNoLinks(layout.root, layout.lock);
    fs.unlinkSync(layout.lock);
  }
}

if (require.main === module) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node build-runtime.cjs (output is fixed to desktop/.build/runtime)');
    buildRuntime();
  } catch (error) {
    console.error(`Runtime build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  getLayout, assertStagingPath, resetStaging, runtimeDestination, shouldCopySource,
  copySourceFile, copySourceTree, rendererEnvironment, assertNoRendererEnvFiles,
  rendererCommand, resolveNpmCli, npmInstallCommand, runCommand, captureRendererSources,
  legalFiles, licenseTexts, collectDependencyLicenses, renderDependencyLicenses,
  filterPublishedPlugins, buildRuntime,
};

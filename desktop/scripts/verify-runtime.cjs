'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST = 'runtime-manifest.json';
const ELECTRON_VERSION = '41.0.3';
const GATEWAY = 'comfyui-gateway';
const RENDERER = 'infinite-canvas/web/dist';
const SOURCE_TREES = ['src', 'comfyui-bridge', 'prompts', 'scripts', 'workflows'];
const LEGAL_NAME = /^(?:LICENSE(?:[.-].*)?|NOTICE(?:[.-].*)?|THIRD_PARTY_NOTICES(?:[.-].*)?)$/i;
const SMALL_TENSORS = new Set([
  'comfyui-gateway/resources/vae_approx/taeh3.safetensors',
  'comfyui-gateway/resources/nodes/unpacked/ComfyUI-SeedVR2_VideoUpscaler/pos_emb.pt',
  'comfyui-gateway/resources/nodes/unpacked/ComfyUI-SeedVR2_VideoUpscaler/neg_emb.pt',
]);
const OMITTED_ASSETS = Object.freeze([
  'ComfyUI application and Python runtime',
  'Large generation model weights and LoRAs (resources/bundled and resources/loras)',
  'Local configuration, environment files, credentials, user data, logs and caches',
  'Repository development dependencies, tests and tooling (not dependency-owned files)',
  'Renderer node_modules and pre-existing web/dist (renderer rebuilt from repository source)',
  'Source-editing assistant registration and assistant service',
]);
const INCLUDED_ASSETS = Object.freeze([
  'Custom-node sources and required node archives from resources/nodes, with their notices',
  'TAEH3 preview VAE and SeedVR2 positive/negative embedding tensors (explicit small-asset exceptions)',
]);
const REQUIRED_FILES = Object.freeze([
  'VERSION', 'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md',
  'infinite-canvas/LICENSE', 'DEPENDENCY-LICENSES.txt',
  'launcher/start.mjs', 'launcher/bootstrap-nodes.mjs', 'launcher/desktop-protocol.mjs', 'launcher/desktop-comfy-bootstrap.py',
  `${RENDERER}/index.html`, `${RENDERER}/config.js`, `${RENDERER}/plugins/index.json`,
  `${GATEWAY}/package.json`, `${GATEWAY}/package-lock.json`,
  `${GATEWAY}/src/server.js`, `${GATEWAY}/src/config.js`, `${GATEWAY}/src/admin.html`,
  `${GATEWAY}/comfyui-bridge/open-workflow.js`, `${GATEWAY}/workflows/registry.json`,
  `${GATEWAY}/workflow-baseline.json`, `${GATEWAY}/resources/index.json`,
  ...SMALL_TENSORS,
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function validRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !/[\x00-\x1f:]/.test(value) && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function assertRelative(value) {
  if (!validRelative(value)) throw new Error(`Unsafe relative path: ${JSON.stringify(value)}`);
  return value;
}

function assertNoLinks(root, target = root) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const rel = path.relative(absoluteRoot, absoluteTarget);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new Error('Path escapes its approved root');
  let cursor = absoluteRoot;
  for (const piece of ['', ...rel.split(path.sep).filter(Boolean)]) {
    if (piece) cursor = path.join(cursor, piece);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symbolic links/junctions are not allowed: ${cursor}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return absoluteTarget;
}

function listRegularFiles(root) {
  assertNoLinks(root);
  const output = [];
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertRelative(relative);
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links/junctions are not allowed: ${relative}`);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) output.push(relative);
      else throw new Error(`Non-regular runtime entry: ${relative}`);
    }
  }
  walk(path.resolve(root), '');
  return output.sort();
}

function digestFile(file) {
  return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: fs.statSync(file).size };
}

function isPrivateOrGenerated(relative) {
  const parts = relative.split('/');
  return parts.some((part) => /^(?:\.git|\.svn|\.hg|\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?|__pycache__|\.pytest_cache|\.mypy_cache|\.cache|\.venv|venv|logs?|cache|data|user-data|userdata|secrets?|credentials?)$/i.test(part))
    || /\.(?:pyc|pyo|log|pem|key|pfx|p12)$/i.test(relative);
}

function assertAllowedRuntimeFile(relative) {
  assertRelative(relative);
  if (isPrivateOrGenerated(relative)) throw new Error(`Private/generated runtime path is forbidden: ${relative}`);
  if (/\.(?:safetensors|gguf|ckpt|pt|pth|onnx|whl|bin)$/i.test(relative) && !SMALL_TENSORS.has(relative)) {
    throw new Error(`Unapproved weight/runtime binary: ${relative}`);
  }
  const rootLegal = !relative.includes('/') && LEGAL_NAME.test(relative);
  const canvasLegal = relative.startsWith('infinite-canvas/') && relative.split('/').length === 2 && LEGAL_NAME.test(path.posix.basename(relative));
  const allowed = rootLegal || canvasLegal || ['VERSION', 'infinite-canvas/VERSION', MANIFEST, 'DEPENDENCY-LICENSES.txt'].includes(relative)
    || relative === 'launcher/desktop-comfy-bootstrap.py'
    || /^launcher\/(?:start|bootstrap-nodes|desktop-protocol)\.mjs$/.test(relative)
    || relative.startsWith(`${RENDERER}/`)
    || [`${GATEWAY}/package.json`, `${GATEWAY}/package-lock.json`, `${GATEWAY}/workflow-baseline.json`, `${GATEWAY}/resources/index.json`].includes(relative)
    || SOURCE_TREES.some((tree) => relative.startsWith(`${GATEWAY}/${tree}/`))
    || relative.startsWith(`${GATEWAY}/node_modules/`)
    || relative.startsWith(`${GATEWAY}/resources/nodes/`)
    || SMALL_TENSORS.has(relative);
  if (!allowed) throw new Error(`Runtime file is outside the allowlist: ${relative}`);
  if (relative.includes('/node_modules/') && !relative.startsWith(`${GATEWAY}/node_modules/`)) throw new Error(`Unexpected node_modules: ${relative}`);
  return relative;
}

function validateLock(packageJson, lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || !lock.packages['']) throw new Error('An npm v2/v3 package lock is required');
  const root = lock.packages[''];
  if (root.name !== packageJson.name || root.version !== packageJson.version) throw new Error('package.json and lock root identity differ');
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const normalize = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
    if (normalize(root[field]) !== normalize(packageJson[field])) throw new Error(`package.json and lock ${field} differ`);
  }
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative) continue;
    assertRelative(relative);
    if (!/^(?:node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(relative) || entry.link) throw new Error(`Unsupported linked/non-registry package: ${relative}`);
    if (!entry.version || /^(?:file:|git\+|git:)/i.test(entry.resolved || '')) throw new Error(`Unpinned/local dependency: ${relative}`);
  }
  return lock;
}

function installedPackages(packageRoot) {
  const found = [];
  function modules(directory, prefix) {
    if (!fs.existsSync(directory)) return;
    assertNoLinks(packageRoot, directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.package-lock.json') continue;
      if (entry.name === '.bin') continue; // npm executable shims; not package identities
      if (entry.name.startsWith('.')) throw new Error(`Unexpected node_modules entry: ${entry.name}`);
      const full = path.join(directory, entry.name);
      assertNoLinks(packageRoot, full);
      if (!entry.isDirectory()) throw new Error(`Non-directory package: ${full}`);
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(full)) add(path.join(full, scoped), `${prefix}/${entry.name}/${scoped}`);
      } else add(full, `${prefix}/${entry.name}`);
    }
  }
  function add(directory, relative) {
    assertNoLinks(packageRoot, directory);
    const packageFile = path.join(directory, 'package.json');
    if (!fs.existsSync(packageFile)) throw new Error(`Package lacks package.json: ${relative}`);
    found.push({ relative, directory, packageJson: readJson(packageFile) });
    modules(path.join(directory, 'node_modules'), `${relative}/node_modules`);
  }
  modules(path.join(packageRoot, 'node_modules'), 'node_modules');
  return found.sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
}

function validateInstalledDependencies(packageRoot) {
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  const lock = validateLock(pkg, readJson(path.join(packageRoot, 'package-lock.json')));
  const installed = installedPackages(packageRoot);
  const seen = new Set();
  for (const item of installed) {
    const entry = lock.packages[item.relative];
    if (!entry || entry.dev === true) throw new Error(`Extraneous/dev dependency installed: ${item.relative}`);
    const expectedName = entry.name || item.relative.split('/node_modules/').at(-1).replace(/^node_modules\//, '');
    if (item.packageJson.version !== entry.version || item.packageJson.name !== expectedName) throw new Error(`Installed dependency differs from lock: ${item.relative}`);
    seen.add(item.relative);
  }
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (relative && !entry.dev && !entry.optional && !seen.has(relative)) throw new Error(`Missing locked production dependency: ${relative}`);
  }
  return installed;
}

function collectFileHashes(root) {
  return Object.fromEntries(listRegularFiles(root).filter((file) => file !== MANIFEST).map((relative) => {
    assertAllowedRuntimeFile(relative);
    return [relative, digestFile(path.join(root, relative))];
  }));
}

function createManifest(root, { buildVersion, sourceVersion, sourceFiles = {} }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(buildVersion || '')) throw new Error('Invalid desktop build version');
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(sourceVersion || '')) throw new Error('Invalid source version');
  for (const relative of Object.keys(sourceFiles)) assertRelative(relative);
  return {
    schema: 1, buildVersion, sourceVersion, electronVersion: ELECTRON_VERSION,
    hashAlgorithm: 'sha256', manifestSelfExcluded: true,
    includedAssets: [...INCLUDED_ASSETS], omittedAssets: [...OMITTED_ASSETS],
    sourceFiles: Object.fromEntries(Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    files: collectFileHashes(root),
  };
}

function writeManifest(root, options) {
  const manifest = createManifest(root, options);
  fs.writeFileSync(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function verifyRuntime(root) {
  const absolute = path.resolve(root);
  const files = listRegularFiles(absolute);
  for (const file of files) assertAllowedRuntimeFile(file);
  for (const file of [...REQUIRED_FILES, MANIFEST]) if (!files.includes(file)) throw new Error(`Missing required runtime file: ${file}`);
  for (const tree of SOURCE_TREES) if (!files.some((file) => file.startsWith(`${GATEWAY}/${tree}/`))) throw new Error(`Missing production source tree: ${tree}`);
  if (!files.some((file) => file.startsWith(`${GATEWAY}/resources/nodes/unpacked/`))) throw new Error('Missing bundled custom-node sources');
  const manifest = readJson(path.join(absolute, MANIFEST));
  const expectedKeys = ['schema', 'buildVersion', 'sourceVersion', 'electronVersion', 'hashAlgorithm', 'manifestSelfExcluded', 'includedAssets', 'omittedAssets', 'sourceFiles', 'files'].sort();
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys) || manifest.schema !== 1 || manifest.electronVersion !== ELECTRON_VERSION || manifest.hashAlgorithm !== 'sha256' || manifest.manifestSelfExcluded !== true) throw new Error('Unsupported runtime manifest schema/metadata');
  if (JSON.stringify(manifest.omittedAssets) !== JSON.stringify(OMITTED_ASSETS) || JSON.stringify(manifest.includedAssets) !== JSON.stringify(INCLUDED_ASSETS)) throw new Error('Runtime asset policy differs from manifest');
  const regenerated = createManifest(absolute, manifest);
  if (manifest.sourceVersion !== fs.readFileSync(path.join(absolute, 'VERSION'), 'utf8').trim()) throw new Error('Runtime source version differs from VERSION');
  for (const [relative, value] of Object.entries(manifest.sourceFiles)) {
    assertRelative(relative);
    if (!value || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 0 || Object.keys(value).sort().join(',') !== 'sha256,size') throw new Error(`Invalid source digest: ${relative}`);
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid manifest files');
  const expected = Object.keys(manifest.files).sort();
  const actual = Object.keys(regenerated.files).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Manifest file set differs from runtime (missing/extra files)');
  for (const relative of expected) {
    assertAllowedRuntimeFile(relative);
    const recorded = manifest.files[relative];
    const observed = regenerated.files[relative];
    if (!recorded || recorded.sha256 !== observed.sha256 || recorded.size !== observed.size || Object.keys(recorded).sort().join(',') !== 'sha256,size') throw new Error(`Manifest hash mismatch: ${relative}`);
  }
  const plugins = readJson(path.join(absolute, RENDERER, 'plugins/index.json'));
  if (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== 'string' || /canvas-assistant\.js/i.test(entry))) throw new Error('Published plugin registry must not register the source-editing assistant');
  const dependencies = validateInstalledDependencies(path.join(absolute, GATEWAY));
  return { buildVersion: manifest.buildVersion, sourceVersion: manifest.sourceVersion, files: actual.length, productionDependencies: dependencies.length };
}

if (require.main === module) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node verify-runtime.cjs [runtime-directory]');
    const result = verifyRuntime(process.argv[2] || path.resolve(__dirname, '../.build/runtime'));
    console.log(`Runtime verified: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`Runtime verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MANIFEST, ELECTRON_VERSION, GATEWAY, RENDERER, SOURCE_TREES, LEGAL_NAME,
  REQUIRED_FILES, SMALL_TENSORS, OMITTED_ASSETS, INCLUDED_ASSETS,
  readJson, validRelative, assertRelative, assertNoLinks, listRegularFiles, digestFile,
  isPrivateOrGenerated, assertAllowedRuntimeFile, validateLock, installedPackages,
  validateInstalledDependencies, collectFileHashes, createManifest, writeManifest, verifyRuntime,
};

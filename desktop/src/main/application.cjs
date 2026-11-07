'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { localUrl } = require('./services.cjs');
const { migrateFastDraft } = require('./fast-draft-migration.cjs');
const { migrateQwenV2 } = require('./qwen-v2-migration.cjs');

const DEFAULTS = {
  schemaVersion: 1, comfyUrl: 'http://127.0.0.1:8188', comfyDir: '', comfyWorkflowsDir: '',
  canvasPort: 23110, gatewayPort: 23111, comfyStartTimeoutSec: 300, gatewayStartTimeoutSec: 30,
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validateConfig(input, { checkDirectories = false } = {}) {
  const result = { ...DEFAULTS };
  result.comfyUrl = localUrl(input.comfyUrl ?? DEFAULTS.comfyUrl);
  for (const key of ['comfyDir', 'comfyWorkflowsDir']) {
    const value = String(input[key] || '').trim();
    if (value && !path.isAbsolute(value)) throw new Error(`${key} 必须是绝对目录`);
    if (value && checkDirectories && (!fs.existsSync(value) || !fs.statSync(value).isDirectory())) throw new Error(`${key} 目录不存在`);
    result[key] = value;
  }
  for (const key of ['canvasPort', 'gatewayPort']) {
    const value = Number(input[key] ?? DEFAULTS[key]);
    if (!Number.isInteger(value) || value < 1024 || value > 65525) throw new Error(`${key} 必须在 1024–65525 之间`);
    result[key] = value;
  }
  if (result.canvasPort === result.gatewayPort) throw new Error('画布和网关不能使用同一端口');
  for (const key of ['comfyStartTimeoutSec', 'gatewayStartTimeoutSec']) {
    const value = Number(input[key] ?? DEFAULTS[key]);
    if (!Number.isInteger(value) || value < 1 || value > 900) throw new Error(`${key} 必须在 1–900 秒之间`);
    result[key] = value;
  }
  return result;
}

// Maintain writable workflows across application upgrades. Only an unchanged
// bundled default may be replaced; user-edited files and extra files survive.
function seedWorkflows(source, destination, baselineFile) {
  migrateFastDraft(source, destination, baselineFile);
  const qwen = migrateQwenV2(source, destination, baselineFile);
  const protectedFiles = new Set(qwen.conflicts.flatMap(item => item.files).map(file => file.replace(/\\/g, '/')));
  if (qwen.conflicts.length) protectedFiles.add('registry.json');
  let previous = {};
  if (fs.existsSync(baselineFile)) previous = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const next = { ...previous };
  const conflicts = qwen.conflicts.map(item => `Qwen v2 ${item.id || 'registry'}：${item.reason}（已保留现有文件）`);
  function visit(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Bundled workflow symlinks are not allowed');
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) { visit(path.join(dir, entry.name), rel); continue; }
      if (!entry.isFile()) continue;
      if (protectedFiles.has(rel.replace(/\\/g, '/'))) continue;
      const bytes = fs.readFileSync(path.join(dir, entry.name));
      const digest = hash(bytes);
      const target = path.join(destination, rel);
      const current = fs.existsSync(target) ? hash(fs.readFileSync(target)) : null;
      if (current === null || current === previous[rel]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        next[rel] = digest;
      } else if (current === digest) next[rel] = digest;
      else if (previous[rel] !== digest) conflicts.push(rel);
    }
  }
  visit(source);

  // Existing installations may have a user-edited registry.json. Preserve every
  // existing row while merging only newly shipped IDs, so release workflows
  // (including 3D and fast-draft entries) become available without replacing
  // local imports, edits, or disabled/visibility state.
  const registryRelative = 'registry.json';
  const bundledRegistry = path.join(source, registryRelative);
  const userRegistry = path.join(destination, registryRelative);
  if (fs.existsSync(bundledRegistry) && fs.existsSync(userRegistry)) {
    try {
      const bundled = JSON.parse(fs.readFileSync(bundledRegistry, 'utf8'));
      const current = JSON.parse(fs.readFileSync(userRegistry, 'utf8'));
      if (Array.isArray(bundled.workflows) && Array.isArray(current.workflows)) {
        const ids = new Set(current.workflows.map(item => item?.id).filter(Boolean));
        const missing = bundled.workflows.filter(item => item?.id && !ids.has(item.id));
        if (missing.length) {
          current.workflows.push(...missing);
          fs.writeFileSync(userRegistry, `${JSON.stringify(current, null, 2)}\n`);
          conflicts.push('registry.json (merged new upstream workflow IDs; existing entries preserved)');
        }
      }
    } catch {
      conflicts.push('registry.json (not merged: invalid JSON; existing file preserved)');
    }
  }

  writeJson(baselineFile, next);
  return conflicts;
}

function createApplication({ runtimeRoot, userData, env = process.env }) {
  const required = ['launcher/start.mjs', 'comfyui-gateway/src/server.js', 'infinite-canvas/web/dist/index.html', 'runtime-manifest.json'];
  for (const file of required) {
    if (!fs.existsSync(path.join(runtimeRoot, file))) throw new Error(`桌面运行资源缺失：${file}。开发环境请先运行 npm run build。`);
  }
  fs.mkdirSync(userData, { recursive: true });
  const configFile = path.join(userData, 'config.json');
  if (!fs.existsSync(configFile)) writeJson(configFile, DEFAULTS);
  const config = validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
  const workflowDir = path.join(userData, 'workflows');
  const conflicts = seedWorkflows(path.join(runtimeRoot, 'comfyui-gateway/workflows'), workflowDir,
    path.join(userData, 'workflow-baseline.json'));
  const logDir = path.join(userData, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'desktop.log');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 4 * 1024 * 1024) {
    fs.copyFileSync(logFile, `${logFile}.previous`);
    fs.writeFileSync(logFile, '');
  }
  // Clear inherited backend settings: a desktop app must not accidentally use
  // a terminal's source workspace, credentials, update server, or output folder.
  const childEnv = { ...env };
  for (const key of ['COMFY_URL', 'COMFYUI_DIR', 'COMFY_WORKFLOWS_DIR', 'COMFY_FRONTEND_DIR', 'CANVAS_PORT', 'GATEWAY_PORT',
    'LAUNCHER_CONTROL_PORT', 'GATEWAY_TOKEN', 'DATA_DIR', 'OUTPUT_DIR', 'WORKFLOW_DIR', 'CANVAS_DIST',
    'HOST', 'PORT', 'ALLOW_REMOTE', 'CORS_ORIGINS', 'PUBLIC_BASE_URL', 'LAUNCHER_CONTROL_URL', 'COMFY_PYTHON',
    'RESOURCES_INDEX_URL', 'RESOURCES_INDEX_URL_BACKUP', 'UPDATE_MANIFEST_URL', 'UPDATE_MANIFEST_URL_BACKUP',
    'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete childEnv[key];
  Object.assign(childEnv, {
    DESKTOP_CONFIG_PATH: configFile, DESKTOP_DISTRIBUTION: '1',
    ELECTRON_ENABLE_LOGGING: '0',
    COMFY_URL: config.comfyUrl, COMFYUI_DIR: config.comfyDir, COMFY_WORKFLOWS_DIR: config.comfyWorkflowsDir,
    CANVAS_PORT: String(config.canvasPort), GATEWAY_PORT: String(config.gatewayPort),
    DATA_DIR: path.join(userData, 'gateway'), OUTPUT_DIR: path.join(userData, 'gateway', 'outputs'), WORKFLOW_DIR: workflowDir,
    CANVAS_DIST: path.join(runtimeRoot, 'infinite-canvas/web/dist'),
    GATEWAY_LAUNCHER_CONFIG: configFile, UPDATE_ENABLED: '0', ASSISTANT_ENABLED: '0', DISABLE_NODE_BOOTSTRAP: '1',
  });
  function log(message) {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${String(message).slice(0, 4000)}\n`);
  }
  if (conflicts.length) log(`保留用户修改的工作流：${conflicts.join(', ')}`);
  return {
    runtimeRoot, userData, configFile, logDir, logFile, env: childEnv, conflicts, log,
    readConfig: () => validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))),
    saveConfig: (value) => { const valid = validateConfig(value, { checkDirectories: true }); writeJson(configFile, valid); return valid; },
  };
}

module.exports = { DEFAULTS, createApplication, validateConfig, seedWorkflows, writeJson };

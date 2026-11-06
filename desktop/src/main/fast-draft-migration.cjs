'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const LEGACY_ROW = '69afb09899f44c1d48ab29524a19313593bdcc33bca78ac792a330de7ad2b6ed';
const LEGACY_GRAPH = 'ed8095c171ec60ad1f963b8a6da50a83dec244dd8c38f627f890778f5c9cf824';

// Repair only the exact, shipped broken default, not customized rows/graphs.
function migrateFastDraft(source, destination, baselineFile) {
  const sourceRegistry = path.join(source, 'registry.json');
  const targetRegistry = path.join(destination, 'registry.json');
  const sourceGraph = path.join(source, 'h3-fast-draft.json');
  const targetGraph = path.join(destination, 'h3-fast-draft.json');
  if (![sourceRegistry, targetRegistry, sourceGraph].every(file => fs.existsSync(file))) return false;
  let bundled, current;
  try {
    bundled = JSON.parse(fs.readFileSync(sourceRegistry, 'utf8'));
    current = JSON.parse(fs.readFileSync(targetRegistry, 'utf8'));
  } catch { return false; }
  const rows = current.workflows;
  if (!Array.isArray(rows) || !Array.isArray(bundled.workflows)) return false;
  const replacement = bundled.workflows.find(item => item?.id === 'video-h3-fast');
  const oldRows = rows.filter(item => item?.id === 'video-h3-fast');
  if (oldRows?.length !== 1 || !replacement || digest(JSON.stringify(oldRows[0])) !== LEGACY_ROW) return false;
  const newBytes = fs.readFileSync(sourceGraph);
  const graph = JSON.parse(newBytes);
  if (replacement.file !== 'h3-fast-draft.json' || !replacement.bindings?.frames?.frameMode ||
      graph['6']?.class_type !== 'MiniMaxH3ImageToVideo' || graph['12']?.inputs?.format !== 'video/h264-mp4') return false;
  const oldBytes = fs.existsSync(targetGraph) ? fs.readFileSync(targetGraph) : null;
  if (oldBytes && ![LEGACY_GRAPH, digest(newBytes)].includes(digest(oldBytes))) return false;
  const backupDir = path.join(path.dirname(baselineFile), 'workflow-backups', '0.1.13');
  fs.mkdirSync(backupDir, { recursive: true });
  function backup(name, bytes) {
    const file = path.join(backupDir, `${name}.${digest(bytes)}.bak`);
    if (fs.existsSync(file)) {
      if (digest(fs.readFileSync(file)) !== digest(bytes)) throw new Error('Workflow backup identity mismatch');
    } else fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  backup('registry.json', fs.readFileSync(targetRegistry));
  if (oldBytes) backup('h3-fast-draft.json', oldBytes);
  rows[rows.indexOf(oldRows[0])] = replacement;
  fs.writeFileSync(targetGraph, newBytes);
  fs.writeFileSync(targetRegistry, `${JSON.stringify(current, null, 2)}\n`);
  return true;
}
module.exports = { migrateFastDraft };

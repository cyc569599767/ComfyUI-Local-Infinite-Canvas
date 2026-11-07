'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Preserve object/array order. Whitespace and CRLF are not user customization;
// any value, added property, or reordered object remains outside this allowlist.
const jsonDigest = value => digest(JSON.stringify(value));

// These rows and graphs are pinned to 39b7965 (desktop 0.1.20 / Web 0.24.8),
// and the replacements to the merged Web 0.24.13. Never learn these identities
// from the mutable per-install baseline or from a user's registry.
const MIGRATIONS = [
  {
    id: 'image-qwen21',
    oldRow: '70afddd5f0de63f90495a9dec4c4479f71fcf3bd63b6c317cf86ae662a170d65',
    newRow: 'fa449c4ead9c344edf3b769ddf1b0fa9dfa65c745476465a78cc192c6bf5f222',
    oldGraphs: {
      'image-qwen21-edit-turbo.json': '13a9802dca6f2f9ebb2b9250e9f52a8067f06c6bd51ea0f99532b7ce00968d0f',
      'image-qwen21-inpaint.json': '384fb5db5c50a793619363e3a5c6ad901bfde3ce0efdcbdc9bd013396fa7cc08',
      'image-qwen21-outpaint.json': '882b6aaf8b90841ebe77a563e49b0e007b6be138798fb80ff3b41a3cab982d12',
      'image-qwen21-t2i.json': '4ae81f3097a7b4d72660e0d6d2e4e1be8631fc9b8b3dabc73fd40e2d48577cf0',
    },
    newGraphs: {
      'image-qwen21v2-edit.json': 'f57c7707d165af68b3ee1377c7c0ca037def5778eeba28106b49a1e57cde08ff',
      'image-qwen21v2-t2i.json': 'a725a49861898f3fb630f83d840fc0b218115e1e725e6511cd9f439350557fa2',
      'image-qwen21v2-inpaint.json': '119615dc693b0038f4fec2b6c2f5b43220e43da7a70baf1eb696bc5379b1c95a',
      'image-qwen21v2-remove.json': 'fd7cfb7e4e5c55b4e812bf348b6f41edce11c5f82d4ba3abefb61408fbaf6a69',
      'image-qwen21v2-outpaint.json': 'ec6fe6cf3f1a4bf3a5063d10fd94f6b61b8437e63dd8844d3dd549833b89cc42',
    },
  },
  {
    id: 'image-qwen21-angle',
    oldRow: 'f978ea1d273dd30eb6644e190a5b8cf93009f1feb871009dbbe49f0dfadf8ef9',
    newRow: '691226a8e9df363faf63f59f224919b91f1099b20a41700a4b7f31d09bdcd6b4',
    oldGraphs: { 'image-qwen21-angle.json': '68d26b7f8737e6eae9370cb3c481946255d5bc39894b594ccd5becae715c5c6c' },
    newGraphs: {
      'image-qwen21v2-angle.json': 'a5cc31c7ae247236e3410b7b34748addb751941cccf1b792cce9edf98b923a22',
      'image-qwen21-angle-character.json': '68d26b7f8737e6eae9370cb3c481946255d5bc39894b594ccd5becae715c5c6c',
    },
  },
];

function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function noSymlinkChain(file) {
  let current = path.resolve(file);
  while (true) {
    if (lstat(current)?.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readRegular(file, optional = false) {
  noSymlinkChain(file);
  const stat = lstat(file);
  if (!stat && optional) return null;
  if (!stat?.isFile()) throw new Error(`Regular file required: ${file}`);
  return fs.readFileSync(file);
}

function references(rows) {
  return [...new Set(rows.flatMap(row => [row?.file, ...Object.values(row?.variants || {}).map(item => item?.file)])
    .filter(file => typeof file === 'string' && file && !path.isAbsolute(file) && !/^[a-zA-Z]:/.test(file)
      && !file.split(/[\\/]/).some(part => part === '..' || part === '.' || !part)))];
}

function backupBytes(directory, name, bytes) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Unsafe workflow backup name');
  noSymlinkChain(directory);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.${digest(bytes)}.bak`);
  const existing = readRegular(file, true);
  if (existing) {
    if (!existing.equals(bytes)) throw new Error(`Workflow backup identity mismatch: ${name}`);
  } else {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    if (!readRegular(file).equals(bytes)) throw new Error(`Workflow backup verification failed: ${name}`);
  }
}

function atomicRegistry(file, bytes) {
  noSymlinkChain(file);
  const temporary = `${file}.qwen-v2.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  catch (error) {
    // This exact, exclusively created temporary is owned by this invocation.
    fs.unlinkSync(temporary);
    throw error;
  }
}

/**
 * Run BEFORE generic seeding. Never writes the baseline or removes old graphs.
 * Caller MUST suppress generic whole-registry replacement when conflicts is
 * nonempty, and preserve every conflict.files path during generic copying.
 * Missing-ID merging is still safe because it does not replace existing rows.
 * Result: { migrated: string[], conflicts: { id: string|null, reason: string,
 * files: string[] }[] }. Migration failure throws before registry publication;
 * all previously present bytes remain backed up under workflow-backups/0.1.21.
 */
function migrateQwenV2(source, destination, baselineFile) {
  const result = { migrated: [], conflicts: [] };
  const targetRegistry = path.join(destination, 'registry.json');
  let original, current, bundled;
  try {
    original = readRegular(targetRegistry, true);
    if (!original) return result; // Fresh install: normal seeding supplies v2.
    current = JSON.parse(original);
    bundled = JSON.parse(readRegular(path.join(source, 'registry.json')));
    if (!Array.isArray(current?.workflows) || !Array.isArray(bundled?.workflows)) throw new Error('Registry workflows must be arrays');
  } catch (error) {
    result.conflicts.push({ id: null, reason: `Registry unavailable: ${error.message}`, files: [] });
    return result;
  }

  const plans = [];
  for (const spec of MIGRATIONS) {
    const oldRows = current.workflows.filter(row => row?.id === spec.id);
    if (!oldRows.length) continue; // Missing IDs stay the existing seeder's job.
    const files = [...new Set([...references(oldRows), ...Object.keys(spec.oldGraphs), ...Object.keys(spec.newGraphs)])];
    const conflict = reason => result.conflicts.push({ id: spec.id, reason, files });
    if (oldRows.length !== 1) { conflict('Duplicate current workflow ID'); continue; }
    const rowHash = jsonDigest(oldRows[0]);
    if (rowHash === spec.newRow) continue; // Idempotent; do not re-backup or reset custom graphs.
    if (rowHash !== spec.oldRow) { conflict('Customized or unknown workflow row'); continue; }
    const replacements = bundled.workflows.filter(row => row?.id === spec.id);
    if (replacements.length !== 1 || jsonDigest(replacements[0]) !== spec.newRow) {
      conflict('Bundled replacement row does not match pinned Web 0.24.13'); continue;
    }
    try {
      const oldGraphs = [];
      for (const [name, expected] of Object.entries(spec.oldGraphs)) {
        const bytes = readRegular(path.join(destination, name), true);
        // Absence is unknown, not evidence that a user left the default intact.
        if (!bytes) throw new Error(`Legacy graph missing: ${name}`);
        if (jsonDigest(JSON.parse(bytes)) !== expected) throw new Error(`Customized legacy graph: ${name}`);
        oldGraphs.push({ name, bytes });
      }
      const newGraphs = [];
      for (const [name, expected] of Object.entries(spec.newGraphs)) {
        const bytes = readRegular(path.join(source, name));
        if (jsonDigest(JSON.parse(bytes)) !== expected) throw new Error(`Bundled graph identity mismatch: ${name}`);
        const existing = readRegular(path.join(destination, name), true);
        if (existing && jsonDigest(JSON.parse(existing)) !== expected) throw new Error(`Destination graph collision: ${name}`);
        newGraphs.push({ name, bytes, existing });
      }
      plans.push({ spec, oldRow: oldRows[0], replacement: replacements[0], oldGraphs, newGraphs });
    } catch (error) { conflict(error.message); }
  }
  if (!plans.length) return result;

  // Validate every backup before publishing any graph or changing the registry.
  // Names encode exact RAW-byte SHA256, unlike the whitespace-tolerant allowlist.
  const backupDir = path.join(path.dirname(baselineFile), 'workflow-backups', '0.1.21');
  const baselineBytes = readRegular(baselineFile, true);
  backupBytes(backupDir, 'registry.json', original);
  if (baselineBytes) backupBytes(backupDir, 'workflow-baseline.json', baselineBytes);
  for (const plan of plans) for (const graph of plan.oldGraphs) backupBytes(backupDir, graph.name, graph.bytes);

  for (const plan of plans) {
    for (const graph of plan.oldGraphs) {
      if (!readRegular(path.join(destination, graph.name)).equals(graph.bytes)) throw new Error(`Legacy graph changed during migration: ${graph.name}`);
    }
    for (const graph of plan.newGraphs) {
      const file = path.join(destination, graph.name);
      const now = readRegular(file, true);
      if (graph.existing) {
        if (!now?.equals(graph.existing)) throw new Error(`Destination graph changed during migration: ${graph.name}`);
      } else {
        if (now) throw new Error(`Destination graph appeared during migration: ${graph.name}`);
        fs.writeFileSync(file, graph.bytes, { flag: 'wx', mode: 0o600 });
        if (!readRegular(file).equals(graph.bytes)) throw new Error(`Destination graph verification failed: ${graph.name}`);
      }
    }
  }
  if (!readRegular(targetRegistry).equals(original)) throw new Error('Registry changed during migration');
  for (const plan of plans) current.workflows[current.workflows.indexOf(plan.oldRow)] = plan.replacement;
  atomicRegistry(targetRegistry, Buffer.from(`${JSON.stringify(current, null, 2)}\n`));
  result.migrated = plans.map(plan => plan.spec.id);
  return result;
}

module.exports = { migrateQwenV2 };

import fs from "node:fs/promises";
import path from "node:path";
import { mimeFromFilename } from "./util.js";

// Only completed output references beneath the configured local Comfy output
// root. Reject traversal and symlink escapes; input/temp are never host reads.
export async function readLocalOutput(root, file, { signal } = {}) {
  if (!root || file?.type !== "output") return null;
  const filename = String(file.filename || "");
  const subfolder = String(file.subfolder || "");
  if (!filename || /[\\/:\0]/.test(filename) || [".", ".."].includes(filename)) throw new Error("Unsafe ComfyUI output filename");
  if (path.isAbsolute(subfolder) || /[:\0]/.test(subfolder) || subfolder.split(/[\\/]/).includes("..")) throw new Error("Unsafe ComfyUI output subfolder");
  const actualRoot = await fs.realpath(root);
  const target = path.resolve(actualRoot, subfolder, filename);
  const relative = path.relative(actualRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("ComfyUI output escapes output directory");
  let actual;
  try { actual = await fs.realpath(target); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const actualRelative = path.relative(actualRoot, actual);
  if (!actualRelative || actualRelative.startsWith("..") || path.isAbsolute(actualRelative)) throw new Error("ComfyUI output symlink escapes output directory");
  const handle = await fs.open(actual, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 1024 ** 3) throw new Error("ComfyUI output size is invalid or exceeds 1 GiB");
    signal?.throwIfAborted();
    const buffer = await handle.readFile({ signal });
    const after = await handle.stat();
    if (buffer.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("ComfyUI output changed while reading");
    return { buffer, contentType: mimeFromFilename(filename) };
  } finally { await handle.close(); }
}

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { bindingSummary, canonicalAspectRatio, convertUiWorkflow, detectFreeBindings, pruneUnreachableNodes } from "./ui-workflow.js";
import { deepClone, nowIso, randomId, writeJsonAtomic } from "./util.js";

const FILE_NAME = "free-workflows.json";
const SOURCE_CACHE_MS = 60 * 1000;
const OBJECT_INFO_MS = 30 * 1000;

function sourceSignature(stat) {
  return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

function imageValue(uploaded) {
  if (!uploaded) return undefined;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

/**
 * 自定义绑定项的写回值转换。
 *
 * 前端传上来的统一是字符串或数字，但写回工作流时必须保持原类型：
 * `steps` 是 20 而 `"20"` 会让 ComfyUI 直接报校验失败；`sampler_name` 是字符串，
 * 写成数字同样会失败。所以按工作流里该输入的现有值类型来定，而不是猜。
 */
/** 固定项的显示位置：卡片上直接编辑，还是收进「生成设置」里。 */
const BINDING_SURFACES = new Set(["card", "settings"]);

/**
 * 固定项对外的形态。
 *
 * 一律走这里再返回给前端，避免「保存时带 surface、读取时又漏掉」这种两处不同步的错：
 * 那样用户切到生成设置、刷新后它又跳回卡片上，看起来像没保存。
 */
export function publicBinding(item) {
  return {
    node: String(item?.node ?? ""),
    input: String(item?.input ?? ""),
    label: String(item?.label || item?.input || ""),
    surface: BINDING_SURFACES.has(item?.surface) ? item.surface : "card",
    ...(item?.unpinned === true ? { unpinned: true } : {}),
  };
}

function normalizePreset(preset) {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) return null;
  const normalized = {
    size: typeof preset.size === "string" && preset.size.trim() ? preset.size.trim() : undefined,
    aspectRatio: canonicalAspectRatio(preset.aspectRatio) || undefined,
    count: Number.isFinite(Number(preset.count)) && Number(preset.count) >= 1 ? Math.floor(Number(preset.count)) : undefined,
    seed: preset.seed !== undefined && preset.seed !== null && String(preset.seed).trim() ? String(preset.seed).trim() : undefined,
    seedFixed: String(preset.seedFixed || "") === "true" ? "true" : "false",
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function coerceCustomValue(original, incoming) {
  if (typeof original === "number") {
    const value = Number(incoming);
    return Number.isFinite(value) ? value : original;
  }
  if (typeof original === "boolean") return incoming === true || String(incoming) === "true";
  return typeof incoming === "string" ? incoming : String(incoming ?? "");
}

export function applyFreeInputs(workflow, bindings, { prompt, texts = [], values = [], uploadedImages = [], uploadedAudios = [], size, count, seed, seedFixed, ratio } = {}) {
  const next = deepClone(pruneUnreachableNodes(workflow) || {});
  // 只允许写回已明确登记的位置：扫描出的文本输入，或用户主动固定到卡片上的配置项。
  // 不做「任意输入可写」，否则前端能改到模型文件名、图片路径这类字段。
  const allowed = new Set((bindings.textInputs || []).map((item) => `${item.node}\u0000${item.input}`));
  const customAllowed = new Set((bindings.customBindings || []).filter((item) => !item.unpinned).map((item) => `${item.node}\u0000${item.input}`));
  const textWrites = new Map();
  for (const item of Array.isArray(texts) ? texts : []) {
    const key = `${item?.node}\u0000${item?.input}`;
    if (!allowed.has(key)) continue;
    textWrites.set(key, String(item?.value ?? ""));
  }
  for (const [key, value] of textWrites) {
    const [nodeId, input] = key.split("\u0000");
    const node = next[nodeId];
    if (node?.inputs) node.inputs[input] = value;
  }
  // 自定义绑定项排在文本之后：同一个输入若既被识别成文本框又被固定，以固定值为准。
  for (const item of Array.isArray(values) ? values : []) {
    const key = `${item?.node}\u0000${item?.input}`;
    if (!customAllowed.has(key) || item?.value === undefined) continue;
    const node = next[String(item.node)];
    if (!node?.inputs) continue;
    node.inputs[String(item.input)] = coerceCustomValue(node.inputs[String(item.input)], item.value);
  }
  if (bindings.prompt && !textWrites.has(`${bindings.prompt.node}\u0000${bindings.prompt.input}`)) {
    const node = next[bindings.prompt.node];
    if (node?.inputs) node.inputs[bindings.prompt.input] = String(prompt || "");
  }
  (bindings.images || []).forEach((binding, index) => {
    const uploaded = uploadedImages[index];
    const value = imageValue(uploaded);
    const node = next[binding.node];
    if (value !== undefined && node?.inputs) node.inputs[binding.input] = value;
  });
  // 参考音频（音色克隆）：LoadAudio 的 audio 是文件名 combo，必须写字符串。
  // 没上传参考音频时保持工作流原值不动——ComfyUI 会自己报缺失，比网关猜测更准确。
  (bindings.audios || []).forEach((binding, index) => {
    const uploaded = uploadedAudios[index];
    const value = imageValue(uploaded);
    const node = next[binding.node];
    if (value !== undefined && node?.inputs) node.inputs[binding.input] = value;
  });
  if (size?.width && size?.height) {
    for (const binding of bindings.sizes || []) {
      const node = next[binding.node];
      if (!node?.inputs) continue;
      node.inputs[binding.widthInput] = size.width;
      node.inputs[binding.heightInput] = size.height;
    }
  }
  const wantedRatio = canonicalAspectRatio(ratio);
  if (wantedRatio) {
    for (const binding of bindings.ratios || []) {
      const node = next[binding.node];
      if (!node?.inputs) continue;
      const options = binding.options || [];
      const match = options.find((option) => canonicalAspectRatio(option) === wantedRatio);
      if (match) node.inputs[binding.input] = match;
    }
  }
  const normalizedCount = Math.max(1, Math.min(15, Math.floor(Number(count) || 1)));
  for (const binding of bindings.batches || []) {
    const node = next[binding.node];
    if (node?.inputs) node.inputs[binding.input] = normalizedCount;
  }
  if (bindings.seeds?.length) {
    const fixed = String(seedFixed ?? "") === "true" && Number(seed) > 0;
    const value = fixed ? Math.floor(Number(seed)) : randomSeed();
    for (const binding of bindings.seeds) {
      const node = next[binding.node];
      if (node?.inputs) node.inputs[binding.input] = value;
    }
  }
  return next;
}

export function createFreeWorkflowStore({ dataDir, comfyWorkflowsDir = "", getComfyWorkflowsDir, comfy, logger, maxWorkflowBytes = 5 * 1024 * 1024 } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  const entries = new Map();
  const sourceCache = new Map();
  let objectInfoCache = null;
  let objectInfoAt = 0;
  let persistQueue = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      for (const entry of raw.workflows || []) {
        if (entry?.id && entry.workflow && entry.bindings) entries.set(entry.id, entry);
      }
    } catch {
      // First run.
    }
  }

  function persist() {
    const payload = { version: 1, updatedAt: nowIso(), workflows: [...entries.values()] };
    // 请求必须收到落盘错误；队列本身捕获错误，保证后续保存仍可继续。
    const write = persistQueue.then(() => writeJsonAtomic(file, payload));
    persistQueue = write.catch((error) => logger?.warn?.(`保存自由卡片失败：${error.message}`));
    return write;
  }

  function rootDir() {
    const currentDir = typeof getComfyWorkflowsDir === "function" ? getComfyWorkflowsDir() : comfyWorkflowsDir;
    return currentDir ? path.resolve(currentDir) : "";
  }

  function resolveSource(relative) {
    const root = rootDir();
    if (!root) throw new Error("网关没有配置 ComfyUI 工作流目录");
    const value = String(relative || "").replace(/\\/g, "/").trim();
    if (!value || path.isAbsolute(value) || value.split("/").includes("..")) throw new Error("工作流路径不合法");
    const resolved = path.resolve(root, value);
    if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) throw new Error("工作流路径不合法");
    return resolved;
  }

  async function getObjectInfo(force = false) {
    if (!force && objectInfoCache && Date.now() - objectInfoAt < OBJECT_INFO_MS) return objectInfoCache;
    objectInfoCache = await comfy.objectInfo();
    objectInfoAt = Date.now();
    return objectInfoCache;
  }

  async function readSource(relative) {
    const sourcePath = resolveSource(relative);
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) throw new Error("工作流不是文件");
    if (stat.size > maxWorkflowBytes) throw new Error("工作流文件过大");
    const text = (await fsp.readFile(sourcePath, "utf8")).replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("工作流 JSON 无法解析");
    }
    if (isApiWorkflow(parsed)) return { workflow: parsed, format: "api", signature: sourceSignature(stat), sourcePath };
    if (isUiWorkflow(parsed)) {
      const objectInfo = await getObjectInfo();
      const converted = convertUiWorkflow(parsed, objectInfo);
      return { workflow: converted.workflow, format: "ui", signature: sourceSignature(stat), sourcePath, warnings: converted.warnings };
    }
    throw new Error("不是 ComfyUI UI 或 API 工作流");
  }

  async function readRawWorkflow(entry) {
    const sourcePath = resolveSource(entry.sourceRel);
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) throw new Error("工作流不是文件");
    if (stat.size > maxWorkflowBytes) throw new Error("工作流文件过大");
    const text = (await fsp.readFile(sourcePath, "utf8")).replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("工作流 JSON 无法解析");
    }
    if (isApiWorkflow(parsed)) return { workflow: parsed, format: "api", sourceRel: entry.sourceRel, name: entry.name };
    if (isUiWorkflow(parsed)) return { workflow: parsed, format: "ui", sourceRel: entry.sourceRel, name: entry.name };
    throw new Error("不是 ComfyUI UI 或 API 工作流");
  }

  async function scanDir(dir, root, out) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await scanDir(full, root, out);
        continue;
      }
      if (!item.isFile() || !item.name.toLowerCase().endsWith(".json")) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.size > maxWorkflowBytes) continue;
      const signature = sourceSignature(stat);
      const cached = sourceCache.get(full);
      if (cached?.signature === signature) {
        out.push({ ...cached.info, updatedAt: new Date(stat.mtimeMs).toISOString() });
        continue;
      }
      let format = "invalid";
      try {
        const parsed = JSON.parse((await fsp.readFile(full, "utf8")).replace(/^\uFEFF/, ""));
        if (isApiWorkflow(parsed)) format = "api";
        else if (isUiWorkflow(parsed)) format = "ui";
      } catch {
        // Keep invalid; the UI can show it as unavailable.
      }
      const info = {
        id: relative,
        name: path.basename(item.name, ".json"),
        folder: path.dirname(relative) === "." ? "" : path.dirname(relative),
        relative,
        format,
      };
      sourceCache.set(full, { signature, info });
      out.push({ ...info, updatedAt: new Date(stat.mtimeMs).toISOString() });
    }
  }

  async function listSources() {
    const root = rootDir();
    if (!root) return [];
    const out = [];
    await scanDir(root, root, out);
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.relative.localeCompare(b.relative));
  }

  async function sourceState(entry) {
    try {
      const stat = await fsp.stat(resolveSource(entry.sourceRel));
      return { exists: stat.isFile(), changed: sourceSignature(stat) !== entry.sourceSignature };
    } catch {
      return { exists: false, changed: true };
    }
  }

  async function importSource(relative) {
    const source = await readSource(relative);
    const bindings = detectFreeBindings(source.workflow, await getObjectInfo());
    const warnings = [...(source.warnings || []), ...(bindings.warnings || [])];
    const stat = await fsp.stat(source.sourcePath);
    const entry = {
      id: randomId("free_"),
      name: path.basename(relative).replace(/\.json$/i, ""),
      sourceRel: String(relative).replace(/\\/g, "/"),
      sourceFormat: source.format,
      sourceSignature: source.signature,
      sourceUpdatedAt: new Date(stat.mtimeMs).toISOString(),
      workflow: source.workflow,
      bindings,
      preset: null,
      warnings,
      customBindings: [],
      archivedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    entries.set(entry.id, entry);
    await persist();
    logger?.info?.(`imported free workflow ${entry.name} (${source.format}, ${bindings.outputType || "unknown"}) ${entry.id}`);
    return entry;
  }

  async function sync(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    const state = await sourceState(entry);
    if (!state.exists) throw new Error("源工作流文件已不存在，可能已在 ComfyUI 中删除");
    if (!state.changed) return { changed: false, entry };
    const source = await readSource(entry.sourceRel);
    const bindings = detectFreeBindings(source.workflow, await getObjectInfo());
    entry.workflow = source.workflow;
    entry.bindings = bindings;
    entry.warnings = [...(source.warnings || []), ...(bindings.warnings || [])];
    entry.sourceFormat = source.format;
    entry.sourceSignature = source.signature;
    entry.sourceUpdatedAt = nowIso();
    entry.updatedAt = nowIso();
    await persist();
    return { changed: true, entry };
  }

  /**
   * 设置「固定到卡片上」的配置项。
   *
   * 每个条目必须是工作流里真实存在、且未被连线占用的输入——否则前端传什么就写什么，
   * 等于把整个工作流暴露成可写。这里先解析一遍工作流再校验，不信任入参。
   */
  async function setCustomBindings(id, list) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    const workflow = pruneUnreachableNodes(entry.workflow) || {};
    const wanted = Array.isArray(list) ? list : [];
    const seen = new Set();
    const next = [];
    for (const raw of wanted.slice(0, 32)) {
      if (!raw || typeof raw !== "object") continue;
      const nodeId = String(raw.node ?? "").trim();
      const input = String(raw.input ?? "").trim();
      if (!nodeId || !input) continue;
      const key = `${nodeId}\u0000${input}`;
      if (seen.has(key)) continue;
      const node = workflow[nodeId];
      if (!node?.inputs || !(input in node.inputs)) continue;
      // 已连线的输入由上游决定，写回去没有意义。
      if (Array.isArray(node.inputs[input])) continue;
      seen.add(key);
      next.push({
        node: nodeId,
        input,
        label: String(raw.label || "").trim().slice(0, 60) || input,
        // 没带 surface 的旧数据默认放卡片上，和加这个字段之前的表现一致。
        surface: BINDING_SURFACES.has(raw.surface) ? raw.surface : "card",
        ...(raw.unpinned === true ? { unpinned: true } : {}),
      });
    }
    entry.customBindings = next;
    entry.updatedAt = nowIso();
    await persist();
    return entry;
  }

  async function setArchived(id, archived, preset, { texts = [], values = [] } = {}) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    if (!Array.isArray(texts) || !Array.isArray(values)) throw new Error("配置值必须是数组");
    const next = structuredClone(entry);
    next.archivedAt = archived ? entry.archivedAt || nowIso() : null;
    if (preset && typeof preset === "object" && !Array.isArray(preset)) next.preset = normalizePreset(preset);
    if (archived) snapshotInputs(next, texts, values);
    next.updatedAt = nowIso();
    entries.set(id, next);
    try {
      await persist();
    } catch (error) {
      entries.set(id, entry);
      throw error;
    }
    return next;
  }

  // 归档与另存共用白名单写入，不调用执行阶段的尺寸/种子随机化，也不写源文件。
  function snapshotInputs(target, texts, values) {
    const write = (writes, allowedBindings) => {
      const allowed = new Set((allowedBindings || []).map((item) => `${item.node}\u0000${item.input}`));
      for (const item of writes) {
        if (!allowed.has(`${item?.node}\u0000${item?.input}`)) continue;
        const inputs = target.workflow[String(item.node)]?.inputs;
        if (!inputs || !Object.hasOwn(inputs, String(item.input))) continue;
        const original = inputs[String(item.input)];
        if (original === null || !["string", "number", "boolean"].includes(typeof original)) continue;
        if (!["string", "number", "boolean"].includes(typeof item.value)) continue;
        if (typeof item.value === "number" && !Number.isFinite(item.value)) continue;
        inputs[String(item.input)] = coerceCustomValue(original, item.value);
      }
    };
    write(texts, target.bindings?.textInputs);
    write(values, (target.customBindings || []).filter((item) => !item.unpinned));
    for (const input of target.bindings?.textInputs || []) {
      const value = target.workflow[input.node]?.inputs?.[input.input];
      if (typeof value === "string") input.default = value;
    }
  }

  /**
   * 把一条自由卡片复制成新条目。
   *
   * 「新增归档」用它：用户的意图是「这个工作流我想另存一套参数」，而不是覆盖原来那条。
   * 复制带上工作流快照、绑定关系、参数预设和固定配置，同时立刻标记为已归档——
   * 这个接口就是「新增归档」，不是普通的草稿复制。
   *
   * 名字加后缀避免在库里出现两条一模一样的标题。
   */
  async function duplicate(id, { preset, name, texts = [], values = [] } = {}) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    if (preset !== undefined && (!preset || typeof preset !== "object" || Array.isArray(preset))) throw new Error("参数预设格式不正确");
    if (!Array.isArray(texts) || !Array.isArray(values)) throw new Error("配置值必须是数组");
    const baseName = String(name || entry.name || "自由卡片").replace(/\s+/g, " ").trim().slice(0, 70) || "自由卡片";
    const timestamp = nowIso();
    const copy = {
      ...structuredClone(entry),
      id: randomId("free_"),
      name: nextCopyName(baseName),
      preset: normalizePreset(preset === undefined ? entry.preset : preset),
      archivedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    snapshotInputs(copy, texts, values);
    entries.set(copy.id, copy);
    try {
      await persist();
    } catch (error) {
      entries.delete(copy.id);
      throw error;
    }
    logger?.info?.(`duplicated free workflow ${entry.name} → ${copy.name} ${copy.id}`);
    return copy;
  }

  /** 「副本」「副本 2」……按现有名字往后排，避免重名。 */
  function nextCopyName(baseName) {
    const taken = new Set([...entries.values()].map((item) => String(item.name)));
    let candidate = `${baseName} 副本`;
    let index = 2;
    while (taken.has(candidate)) {
      candidate = `${baseName} 副本 ${index}`;
      index += 1;
    }
    return candidate;
  }

  function get(id) {
    return entries.get(id) || null;
  }

  async function remove(id) {
    const key = String(id || "").trim();
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    sourceCache.delete(key);
    await persist();
    return entry;
  }

  async function rename(id, name) {
    const entry = entries.get(String(id || "").trim());
    if (!entry) {
      const error = new Error("自由卡片不存在");
      error.status = 404;
      error.code = "free_workflow_not_found";
      throw error;
    }
    const next = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!next) {
      const error = new Error("名称不能为空");
      error.status = 400;
      error.code = "invalid_free_workflow_name";
      throw error;
    }
    if (entry.name !== next) {
      entry.name = next;
      entry.updatedAt = nowIso();
      await persist();
    }
    return entry;
  }

  // 旧卡片保存的是旧版 bindings（没有 textInputs），首次访问时重新识别并落盘。
  async function ensureBindings(entry) {
    if (!entry || Array.isArray(entry.bindings?.textInputs)) return entry;
    try {
      const bindings = detectFreeBindings(entry.workflow, await getObjectInfo());
      entry.bindings = bindings;
      entry.warnings = [...new Set([...(entry.warnings || []), ...(bindings.warnings || [])])];
      entry.updatedAt = nowIso();
      await persist();
    } catch (error) {
      logger?.warn?.(`升级自由卡片文本输入失败 ${entry.id}: ${error.message}`);
    }
    return entry;
  }

  /**
   * 执行时用的 bindings：把用户固定的配置项合并进来。
   *
   * 固定项存在 `entry.customBindings`，而扫描结果存在 `entry.bindings`；`applyFreeInputs`
   * 只认后者身上的 `customBindings`。这两处以前从没接上，后果是**用户在卡片上填的配置
   * 在执行时被静默丢弃**——界面能改、能保存、也能读回，但生成用的还是工作流原值，
   * 表现就是「改了配置，生成结果和没改一样」。
   *
   * 保留 `entry.customBindings` 作为唯一存储，这里只做合并，避免两份真相各自漂移。
   */
  function executionBindings(entry) {
    const bindings = entry?.bindings || {};
    const custom = (Array.isArray(entry?.customBindings) ? entry.customBindings : []).filter((item) => !item.unpinned);
    return { ...bindings, customBindings: custom };
  }

  async function publicEntry(entry) {
    if (!entry) return null;
    await ensureBindings(entry);
    const source = await sourceState(entry);
    return {
      id: entry.id,
      name: entry.name,
      sourceRel: entry.sourceRel,
      sourceFormat: entry.sourceFormat,
      outputType: entry.bindings?.outputType || null,
      archived: Boolean(entry.archivedAt),
      archivedAt: entry.archivedAt || null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sourceChanged: source.changed,
      sourceMissing: !source.exists,
      preset: entry.preset || null,
      customBindings: (entry.customBindings || []).map(publicBinding),
      ...bindingSummary(entry.bindings || {}),
      warnings: entry.warnings || [],
    };
  }

  async function list({ archived } = {}) {
    const result = [];
    for (const entry of [...entries.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
      if (archived === true && !entry.archivedAt) continue;
      if (archived === false && entry.archivedAt) continue;
      result.push(await publicEntry(entry));
    }
    return result;
  }

  return { load, listSources, importSource, sync, setArchived, duplicate, setCustomBindings, get, remove, rename, publicEntry, list, applyFreeInputs, readRawWorkflow, sourceState, ensureBindings, executionBindings };
}

/**
 * 自由卡片与应用的搬家包（bundle）。
 *
 * 为什么不直接导出 `free-workflows.json`：
 *
 * 1. 卡片的 `workflow` 是转换后的 API 格式，脱离源文件就不能再「同步」。
 *    包里必须同时带原始工作流，导入时落到对方的工作流目录，卡片才能重新接上源文件。
 * 2. 卡片能不能跑取决于本机有没有模型和节点。只搬编排不搬依赖，对方打开全是
 *    「缺少模型」。所以包里带依赖清单，导入前先比对，缺什么由用户决定装不装。
 * 3. 应用里的 `steps[].workflowId` 是本机一次性 id，跨机器必然撞不上，
 *    导入时按包内序号重新映射，不能照搬。
 *
 * 包格式是纯 JSON：可读、可 diff、能进 git，不需要解压工具。
 */
import crypto from "node:crypto";

import { discoverModelLoaderSpecs } from "./model-loaders.js";
import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { nowIso } from "./util.js";

export const BUNDLE_KIND = "comfyui-canvas-bundle";
export const BUNDLE_SCHEMA = 1;

/** 单条工作流上限，与网关读源文件的上限一致。 */
const MAX_WORKFLOW_CHARS = 5 * 1024 * 1024;
const MAX_CARDS = 200;
const MAX_APPS = 100;

const asArray = (value) => (Array.isArray(value) ? value : []);
const txt = (value, max = 200) => String(value ?? "").trim().slice(0, max);

/**
 * 工作流指纹：判断「对方是不是已经有这张卡片」。
 *
 * 对象键先排序再序列化，避免同样的图因为键顺序不同得出两个指纹。
 * 取前 32 位十六进制，碰撞概率在这里的规模下可以忽略，同时短到能进文件名。
 */
export function workflowFingerprint(workflow) {
  if (!workflow || typeof workflow !== "object") return "";
  const stable = JSON.stringify(workflow, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

/**
 * 直接从工作流里抽依赖，不依赖 bindings。
 *
 * bindings 是「界面怎么显示」的描述，不含模型文件名；模型名散在节点输入里。
 * 用 `discoverModelLoaderSpecs` 得到「哪些 classType.input 是模型文件」的判定表，
 * 再把工作流里命中的值收集出来——这样第三方 loader 也能覆盖，
 * 不需要在包里写死一份模型清单。
 */
export function collectDependencies(workflow, objectInfo = {}) {
  const specs = discoverModelLoaderSpecs(objectInfo || {});
  const byKey = new Map(specs.map((spec) => [`${spec.classType}\u0000${spec.input}`, spec]));
  const models = [];
  const nodes = new Set();
  for (const node of Object.values(workflow || {})) {
    const classType = txt(node?.class_type, 120);
    if (!classType) continue;
    const installed = objectInfo && Object.hasOwn(objectInfo, classType);
    // 没装过的节点也要报出来：这是「装什么」的输入。
    if (objectInfo && Object.keys(objectInfo).length && !installed) nodes.add(classType);
    for (const [input, value] of Object.entries(node?.inputs || {})) {
      if (typeof value !== "string" || !value) continue;
      const spec = byKey.get(`${classType}\u0000${input}`);
      if (!spec) continue;
      models.push({ classType, input, value: txt(value, 400), dirs: spec.dirs || [] });
    }
  }
  return { models, nodes: [...nodes].sort() };
}

/**
 * 导出单张卡片。
 *
 * 不带 id / 时间戳 / sourceSignature：那些是本机身份，跨机器无意义，
 * 还会让同一张卡片两次导出产生不同文件，没法用 git 管。
 */
export function exportCard(entry, { rawWorkflow, objectInfo } = {}) {
  if (!entry) return null;
  const raw = rawWorkflow || entry.workflow || null;
  return {
    name: txt(entry.name, 80) || "未命名卡片",
    sourceRel: txt(entry.sourceRel, 400),
    sourceFormat: entry.sourceFormat === "ui" ? "ui" : "api",
    workflow: raw,
    fingerprint: workflowFingerprint(raw),
    // 导出的多是「已经调好」的成熟卡片，导入后默认还应是归档的。
    archived: Boolean(entry.archivedAt),
    preset: entry.preset || null,
    customBindings: asArray(entry.customBindings)
      .map((item) => ({
        node: txt(item.node, 40),
        input: txt(item.input, 80),
        label: txt(item.label, 60),
        surface: item.surface === "settings" ? "settings" : "card",
        ...(item.unpinned === true ? { unpinned: true } : {}),
      }))
      .filter((item) => item.node && item.input),
    dependencies: objectInfo === undefined ? undefined : collectDependencies(raw, objectInfo),
  };
}

export function exportApp(app) {
  if (!app) return null;
  return {
    name: txt(app.name, 80) || "未命名应用",
    description: txt(app.description, 400) || undefined,
    steps: asArray(app.steps).map((step, index) => ({
      // 包内按序号引用卡片，不用本机 id
      card: Number.isInteger(step.card) ? step.card : index,
      label: txt(step.label, 60) || undefined,
      column: Number.isInteger(step.column) && step.column >= 0 ? step.column : index,
      row: Number.isInteger(step.row) && step.row >= 0 ? step.row : undefined,
    })),
  };
}

function checksum(cards, apps) {
  return crypto.createHash("sha256").update(JSON.stringify({ cards, apps })).digest("hex").slice(0, 16);
}

export function buildBundle({ cards = [], apps = [], exportedBy = "", now = nowIso() } = {}) {
  const cleanCards = cards.filter(Boolean);
  const cleanApps = apps.filter(Boolean);
  return {
    kind: BUNDLE_KIND,
    schema: BUNDLE_SCHEMA,
    exportedAt: now,
    exportedBy: txt(exportedBy, 80) || undefined,
    cards: cleanCards,
    apps: cleanApps,
    checksum: checksum(cleanCards, cleanApps),
  };
}

function bundleError(message, code = "invalid_bundle") {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

/**
 * 解析并校验包。包是外部输入，可能来自任何机器。
 *
 * 只接受「结构完全认识」的字段，其余一律丢弃，不做「尽量保留」——
 * 否则一个包就能往卡片里塞任意节点写入，绕过 applyFreeInputs 的白名单。
 */
export function parseBundle(input, { maxCards = MAX_CARDS, maxApps = MAX_APPS } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bundleError("包内容不是对象");
  if (input.kind !== BUNDLE_KIND) throw bundleError("不是自由卡片或应用的搬家包");
  if (Number(input.schema) > BUNDLE_SCHEMA) throw bundleError(`包格式版本过新（v${input.schema}），请先升级画布`);

  const rawCards = asArray(input.cards);
  if (rawCards.length > maxCards) throw bundleError(`一次最多导入 ${maxCards} 张卡片`);
  const rawApps = asArray(input.apps);
  if (rawApps.length > maxApps) throw bundleError(`一次最多导入 ${maxApps} 个应用`);

  const problems = [];
  const cards = [];
  rawCards.forEach((raw, index) => {
    const name = txt(raw?.name, 80) || `第 ${index + 1} 张卡片`;
    const workflow = raw?.workflow;
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      problems.push({ index, name, message: "缺少工作流本体" });
      return;
    }
    const format = isApiWorkflow(workflow) ? "api" : isUiWorkflow(workflow) ? "ui" : "";
    if (!format) {
      problems.push({ index, name, message: "工作流既不是 API 格式也不是 UI 格式" });
      return;
    }
    if (JSON.stringify(workflow).length > MAX_WORKFLOW_CHARS) {
      problems.push({ index, name, message: "工作流体积超过上限" });
      return;
    }
    cards.push({
      index,
      name,
      sourceRel: txt(raw?.sourceRel, 400),
      sourceFormat: format,
      workflow,
      fingerprint: workflowFingerprint(workflow),
      archived: raw?.archived === true,
      preset: raw?.preset && typeof raw.preset === "object" && !Array.isArray(raw.preset) ? raw.preset : null,
      customBindings: asArray(raw?.customBindings)
        .slice(0, 32)
        .map((item) => ({
          node: txt(item?.node, 40),
          input: txt(item?.input, 80),
          label: txt(item?.label, 60),
          surface: item?.surface === "settings" ? "settings" : "card",
          ...(item?.unpinned === true ? { unpinned: true } : {}),
        }))
        .filter((item) => item.node && item.input),
    });
  });

  const byIndex = new Map(cards.map((card) => [card.index, card]));
  const apps = [];
  rawApps.forEach((raw, index) => {
    const name = txt(raw?.name, 80);
    if (!name) {
      problems.push({ index, name: `第 ${index + 1} 个应用`, message: "缺少应用名称" });
      return;
    }
    const steps = asArray(raw?.steps)
      .map((step) => {
        const card = byIndex.get(Number(step?.card));
        if (!card) return null;
        return {
          cardIndex: card.index,
          label: txt(step?.label, 60) || undefined,
          column: Number.isInteger(step?.column) && step.column >= 0 ? step.column : 0,
          row: Number.isInteger(step?.row) && step.row >= 0 ? step.row : undefined,
        };
      })
      .filter(Boolean);
    if (!steps.length) {
      problems.push({ index, name, message: "这个应用引用的卡片都不在包里" });
      return;
    }
    apps.push({ name, description: txt(raw?.description, 400) || undefined, steps });
  });

  return { cards, apps, problems, exportedAt: txt(input.exportedAt, 40) || "", exportedBy: txt(input.exportedBy, 80) || "" };
}

/**
 * 生成导入时的工作流文件名。
 *
 * 保留中文和常见符号——中文名的卡片落成 `数字人-a1b2c3d4.json` 用户能认出来，
 * 全删成 `workflow-xxxx.json` 就失去意义了。只挡掉路径分隔符和各系统禁用字符。
 * 指纹后缀保证同一个包重复导入不互相覆盖，也不会撞上同名但内容不同的工作流。
 */
export function bundleWorkflowFileName(card, existing = new Set()) {
  const raw = txt(card?.name, 60) || "workflow";
  const base =
    raw
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 60) || "workflow";
  const suffix = String(card?.fingerprint || "").slice(0, 8) || "workflow";
  let candidate = `${base}-${suffix}.json`;
  let index = 2;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}-${index}.json`;
    index += 1;
  }
  return candidate;
}

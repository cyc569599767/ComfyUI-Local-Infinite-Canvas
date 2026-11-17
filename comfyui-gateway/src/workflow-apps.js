/**
 * 「应用」的服务端存储。
 *
 * 原先应用只存在浏览器 localStorage：换浏览器、清缓存、换设备就全没了，
 * 编排好的固定流程等于一次性消耗品。这里把它落到网关的 data 目录，
 * 和自由卡片放在一起，跟着数据目录走。
 *
 * 存的是编排描述（哪些工作流、什么顺序），不含模型与执行状态，
 * 所以体积很小，直接整份读写即可，不需要分条索引。
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { nowIso, randomId, writeJsonAtomic } from "./util.js";

const FILE_NAME = "workflow-apps.json";

function normalizeStep(raw) {
  if (!raw || typeof raw !== "object") return null;
  const workflowId = String(raw.workflowId || "").trim();
  if (!workflowId) return null;
  const column = Number(raw.column);
  const row = Number(raw.row);
  return {
    workflowId,
    label: String(raw.label || "").trim() || undefined,
    column: Number.isFinite(column) && column >= 0 ? Math.floor(column) : 0,
    row: Number.isFinite(row) && row >= 0 ? Math.floor(row) : undefined,
  };
}

function normalizeApp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  if (!id || !name) return null;
  const now = nowIso();
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map(normalizeStep).filter(Boolean);
  return {
    id,
    name,
    description: String(raw.description || "").trim() || undefined,
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now),
    steps,
  };
}

export function createWorkflowAppStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  let apps = [];
  let persistQueue = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      // 坏条目不能拖垮整个列表：逐个校验，跳过不合法的。
      apps = (Array.isArray(raw?.apps) ? raw.apps : []).map(normalizeApp).filter(Boolean);
    } catch {
      // 首次运行，或文件还没生成。
    }
  }

  function persist() {
    const payload = { version: 1, updatedAt: nowIso(), apps };
    const write = persistQueue.then(() => writeJsonAtomic(file, payload));
    persistQueue = write.catch((error) => logger?.warn?.(`保存应用失败：${error.message}`));
    return write;
  }

  function list() {
    return apps.map((item) => ({ ...item, steps: item.steps.map((step) => ({ ...step })) }));
  }

  /**
   * 新建或整体覆盖一个应用。前端编辑器会带上完整字段，这里只补 id 和时间戳，
   * 避免同一个应用在两端各存一份时间、显示上对不上。
   */
  async function save(input) {
    const normalized = normalizeApp({
      ...input,
      id: String(input?.id || "").trim() || randomId("app_"),
    });
    if (!normalized) throw new Error("应用数据不合法：需要名称和至少一个步骤");
    if (!normalized.steps.length) throw new Error("应用至少要有一个步骤");

    const index = apps.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      normalized.createdAt = apps[index].createdAt;
      normalized.updatedAt = nowIso();
      apps[index] = normalized;
    } else {
      apps.push(normalized);
    }
    await persist();
    return normalized;
  }

  async function remove(id) {
    const next = apps.filter((item) => item.id !== id);
    if (next.length === apps.length) return false;
    apps = next;
    await persist();
    return true;
  }

  return { load, list, save, remove };
}

import fsp from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./util.js";

const FILE_NAME = "workflow-labels.json";
const MAX_LABEL_LENGTH = 64;

/**
 * 工作流显示名（label）的用户覆盖层。
 *
 * registry.json 里的 label 是随仓库分发的默认值，用户改了会被下次更新覆盖，
 * 所以用户自定义名单独存到 dataDir，读 registry 时叠加，和 worklow-visibility 同一套思路。
 */
export function createWorkflowLabelStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  const labels = new Map();

  function normalize(label) {
    return String(label ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, MAX_LABEL_LENGTH);
  }

  async function load() {
    try {
      const raw = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      const entries = raw?.labels && typeof raw.labels === "object" ? raw.labels : {};
      for (const [id, label] of Object.entries(entries)) {
        const key = String(id || "").trim();
        const value = normalize(label);
        if (key && value) labels.set(key, value);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn?.(`读取工作流显示名失败：${error.message}`);
    }
    return list();
  }

  function list() {
    return Object.fromEntries(labels);
  }

  /** 取用户自定义显示名；没有则返回空字符串，交由调用方回落到 registry 默认值。 */
  function get(id) {
    return labels.get(String(id || "").trim()) || "";
  }

  async function persist() {
    await writeJsonAtomic(file, { version: 1, labels: list(), updatedAt: new Date().toISOString() });
  }

  /** 设置显示名；传空值表示恢复默认（删除覆盖）。返回最终生效的自定义值。 */
  async function set(id, label) {
    const key = String(id || "").trim();
    if (!key) throw new Error("缺少工作流 ID");
    const value = normalize(label);
    if (value) labels.set(key, value);
    else labels.delete(key);
    await persist();
    return get(key);
  }

  return { load, list, get, set, normalize, MAX_LABEL_LENGTH };
}

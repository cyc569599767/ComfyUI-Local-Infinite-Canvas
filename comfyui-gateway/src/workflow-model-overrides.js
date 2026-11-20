import fsp from "node:fs/promises";
import path from "node:path";

import { ALL_CREATION_WORKFLOWS } from "./creation-workflows.js";
import { discoverModelLoaderSpecs } from "./model-loaders.js";
import { workflowModelCompatibilityProblem } from "./workflow-model-compatibility.js";
import { isPlainObject, writeJsonAtomic } from "./util.js";

const CREATION_IDS = new Set(ALL_CREATION_WORKFLOWS.map((entry) => entry.id));
const REPOSITORY_INPUTS = new Set(["Qwen3TTSModelLoader\u0000model_name", "Qwen3TTSSenseVoiceASR\u0000model_id"]);
const fieldKey = (nodeId, input) => `${nodeId}\u0000${input}`;
const normalizePath = (value) => value.replace(/\\/g, "/");

function modelError(message, status = 400, code = "invalid_workflow_model") {
  return Object.assign(new Error(message), { status, code });
}

export function assertModelConfigurable(entry) {
  if (!entry) throw modelError("工作流不存在", 404, "workflow_not_found");
  if (entry.source?.kind !== "creation-reference" || !CREATION_IDS.has(entry.id)) {
    throw modelError("仅创作专用参考工作流支持独立模型配置", 403, "workflow_models_forbidden");
  }
}

function safeRelativeValue(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.trim() !== value || /[\x00-\x1f\x7f:]/.test(value)) return false;
  const normalized = normalizePath(value);
  return !normalized.startsWith("/") && normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function safeRepository(value) {
  return safeRelativeValue(value)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value)
    && !/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i.test(value);
}

function inputDefinition(objectInfo, classType, input) {
  const info = objectInfo?.[classType]?.input;
  return info?.required?.[input] ?? info?.optional?.[input];
}

function inputOptions(definition) {
  const values = Array.isArray(definition?.[0]) ? definition[0] : definition?.[1]?.options;
  return Array.isArray(values) ? values : null;
}

function installedFile(value, options) {
  const normalized = normalizePath(value);
  const exact = options.find((option) => normalizePath(option) === normalized);
  if (exact) return exact;
  const basename = normalized.split("/").pop();
  const matches = options.filter((option) => normalizePath(option).split("/").pop() === basename);
  return matches.length === 1 ? matches[0] : "";
}

export function workflowModelFields(entry, objectInfo, { offline = false } = {}) {
  const template = entry.templateWorkflow || entry.workflow;
  const specs = discoverModelLoaderSpecs(objectInfo);
  const fields = [];
  for (const [nodeId, node] of Object.entries(template)) {
    for (const spec of specs) {
      if (spec.classType !== node.class_type || typeof node.inputs?.[spec.input] !== "string") continue;
      const defaultValue = node.inputs[spec.input];
      const value = entry.workflow[nodeId]?.inputs?.[spec.input] ?? defaultValue;
      const definition = inputDefinition(objectInfo, spec.classType, spec.input);
      const enumeration = inputOptions(definition);
      const optionKind = REPOSITORY_INPUTS.has(`${spec.classType}\u0000${spec.input}`) ? "repository" : "files";
      const allOptions = [...new Set((enumeration || []).filter((option) => optionKind === "repository" ? safeRepository(option) : safeRelativeValue(option)))];
      const rejectedOptions = allOptions.flatMap(option => {
        const reason = workflowModelCompatibilityProblem(entry, nodeId, spec.input, option);
        return reason ? [{ value: option, reason }] : [];
      });
      const options = allOptions.filter(option => !rejectedOptions.some(item => item.value === option));
      const compatibilityError = workflowModelCompatibilityProblem(entry, nodeId, spec.input, value);
      const missingNode = !Object.hasOwn(objectInfo || {}, spec.classType);
      const available = !offline && !missingNode && (optionKind === "repository"
        ? (enumeration ? options.includes(value) : definition?.[0] === "STRING" && safeRepository(value))
        : Boolean(installedFile(value, options)));
      fields.push({
        nodeId, input: spec.input, classType: spec.classType,
        label: `${node._meta?.title || spec.classType} · ${spec.input}`,
        defaultValue, value, overridden: value !== defaultValue, available: Boolean(available) && !compatibilityError,
        options, missingNode, optionKind, ...(compatibilityError ? { compatibilityError } : {}), ...(rejectedOptions.length ? { rejectedOptions } : {}),
      });
    }
  }
  return { id: entry.id, label: entry.label || entry.name, fields, ...(offline ? { offline: true } : {}) };
}

export function validateWorkflowModelPatch(entry, body, objectInfo) {
  assertModelConfigurable(entry);
  if (!isPlainObject(body)) throw modelError("模型配置必须是对象");
  if (body.reset === true && Object.keys(body).length === 1) return { reset: true, overrides: [] };
  if (Object.keys(body).some((key) => key !== "overrides") || !Array.isArray(body.overrides) || !body.overrides.length) {
    throw modelError("请提交非空 overrides 数组，或仅提交 reset:true");
  }
  const fields = new Map(workflowModelFields(entry, objectInfo).fields.map((field) => [fieldKey(field.nodeId, field.input), field]));
  const seen = new Set();
  const overrides = body.overrides.map((item) => {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !["nodeId", "input", "value"].includes(key))
      || typeof item.nodeId !== "string" || typeof item.input !== "string" || (item.value !== null && typeof item.value !== "string")) {
      throw modelError("每条覆盖须包含 nodeId、input 和字符串或 null 类型的 value");
    }
    const key = fieldKey(item.nodeId, item.input);
    if (seen.has(key)) throw modelError(`模型字段重复：${item.nodeId}.${item.input}`);
    seen.add(key);
    const field = fields.get(key);
    if (!field) throw modelError(`不是可配置的模型字段：${item.nodeId}.${item.input}`);
    // 恢复默认不要求参考模型已安装，也不要求对应节点插件仍在线。
    if (item.value === null || item.value === field.defaultValue) return { ...item, classType: field.classType, value: null };
    const compatibilityError = workflowModelCompatibilityProblem(entry, item.nodeId, item.input, item.value);
    if (compatibilityError) throw modelError(compatibilityError, 409, "incompatible_workflow_model");
    if (field.missingNode) throw modelError(`缺少节点 ${field.classType}，不能配置模型`);
    if (!safeRelativeValue(item.value)) throw modelError(`模型值不是安全的相对名称：${item.nodeId}.${item.input}`);
    let value;
    if (field.optionKind === "repository") {
      const definition = inputDefinition(objectInfo, field.classType, field.input);
      const enumeration = inputOptions(definition);
      if (!safeRepository(item.value) || (enumeration ? !field.options.includes(item.value) : definition?.[0] !== "STRING")) {
        throw modelError(`模型仓库不在该输入允许的选项内：${item.nodeId}.${item.input}`);
      }
      value = item.value;
    } else {
      value = installedFile(item.value, field.options);
      if (!value) throw modelError(`模型不在该输入的已安装候选中，或同名路径不唯一：${item.nodeId}.${item.input}`);
    }
    return { nodeId: item.nodeId, input: item.input, classType: field.classType, value: value === field.defaultValue ? null : value };
  });
  return { reset: false, overrides };
}

export function createWorkflowModelOverrideStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, "workflow-model-overrides.json");
  let workflows = new Map();
  let pending = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      const next = new Map();
      if (raw.version !== 1 || !isPlainObject(raw.workflows)) throw new Error("模型配置文件格式无效");
      for (const [id, rows] of Object.entries(raw.workflows)) {
        if (!CREATION_IDS.has(id) || !Array.isArray(rows)) continue;
        const values = new Map();
        for (const row of rows) {
          if (!isPlainObject(row) || typeof row.nodeId !== "string" || typeof row.input !== "string" || typeof row.classType !== "string" || !safeRelativeValue(row.value)) continue;
          values.set(fieldKey(row.nodeId, row.input), { nodeId: row.nodeId, input: row.input, classType: row.classType, value: row.value });
        }
        if (values.size) next.set(id, values);
      }
      workflows = next;
    } catch (error) {
      if (error.code !== "ENOENT") logger?.warn?.(`读取工作流模型配置失败：${error.message}`);
    }
  }

  function apply(id, workflow) {
    const rows = workflows.get(id);
    if (!rows?.size) return workflow;
    const result = structuredClone(workflow);
    for (const { nodeId, input, classType, value } of rows.values()) {
      const node = result[nodeId];
      if (node?.class_type === classType && Object.hasOwn(node.inputs, input) && typeof node.inputs[input] === "string") node.inputs[input] = value;
    }
    return result;
  }

  function update(id, { reset = false, overrides = [] }) {
    const operation = pending.catch(() => {}).then(async () => {
      const next = new Map(workflows);
      const rows = reset ? new Map() : new Map(next.get(id));
      for (const row of overrides) {
        const key = fieldKey(row.nodeId, row.input);
        if (row.value === null) rows.delete(key);
        else rows.set(key, { ...row });
      }
      if (rows.size) next.set(id, rows);
      else next.delete(id);
      const serialized = Object.fromEntries([...next].map(([key, values]) => [key, [...values.values()]]));
      // 整个读改写串行化；只有原子落盘成功后才交换内存状态。
      await writeJsonAtomic(file, { version: 1, workflows: serialized });
      workflows = next;
    });
    pending = operation;
    return operation;
  }

  return { load, apply, update };
}

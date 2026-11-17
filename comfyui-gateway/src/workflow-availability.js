function problemText(problems) {
  return (Array.isArray(problems) ? problems : [])
    .map((problem) => String(problem?.message || "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("；");
}

/**
 * 工作流引用了当前 ComfyUI 没有的节点类。
 *
 * 超分这类入口允许「权重还没下载」先提交，但不能允许节点缺失：
 * 那种情况下 ComfyUI 只会丢回一句校验失败，用户看不出是版本问题还是文件问题。
 * 返回缺失的 class_type 列表（去重、保持出现顺序），空数组表示节点齐全。
 */
export function missingNodeClasses(workflow, hasNodeClass) {
  if (typeof hasNodeClass !== "function") return [];
  const missing = [];
  const seen = new Set();
  for (const node of Object.values(workflow || {})) {
    const classType = String(node?.class_type || "");
    if (!classType || seen.has(classType)) continue;
    seen.add(classType);
    if (!hasNodeClass(classType)) missing.push(classType);
  }
  return missing;
}

// 网关是最后一道闸门：旧页面、直接 API 和缓存模型列表都可能提交当前不可用的工作流。
// 这里只返回可序列化的问题描述，由 server 转成 409，避免把原始 ComfyUI 校验错误丢给用户。
export function workflowAvailabilityProblem(setup, entry, { mode = "", allowUnavailable = false } = {}) {
  if (allowUnavailable || !entry || typeof setup?.workflowStatus !== "function") return null;
  const status = setup.workflowStatus(entry.id) || {};
  if (status.checking === true) {
    const detail = problemText(status.problems) || "正在扫描 ComfyUI 模型与节点";
    return {
      code: "workflow_checking",
      message: `模型 ${entry.name || entry.id} 正在检查可用性：${detail}。请稍候或重新扫描后再试。`,
      details: { workflowId: entry.id, checking: true, problems: status.problems || [] },
    };
  }
  if (status.available === false) {
    const detail = problemText(status.problems) || "工作流所需的模型或节点尚未就绪";
    return {
      code: "workflow_unavailable",
      message: `模型 ${entry.name || entry.id} 当前不可用：${detail}。请在资源中心补齐缺失项，或重新扫描后再试。`,
      details: { workflowId: entry.id, problems: status.problems || [] },
    };
  }
  const variant = mode ? status.variants?.[mode] : null;
  if (variant && variant.available === false) {
    const detail = problemText(variant.problems) || "该功能所需的模型或节点尚未就绪";
    return {
      code: "workflow_mode_unavailable",
      message: `模型 ${entry.name || entry.id} 的「${mode}」功能当前不可用：${detail}。请在资源中心补齐缺失项，或重新扫描后再试。`,
      details: { workflowId: entry.id, mode, problems: variant.problems || [] },
    };
  }
  return null;
}

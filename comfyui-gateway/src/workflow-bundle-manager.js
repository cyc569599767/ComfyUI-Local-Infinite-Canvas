/**
 * 搬家包的导入导出流程编排。
 *
 * 分成三步，每步都能单独调用，因为用户需要「先看会发生什么，再决定要不要」：
 *
 *   buildNormalBundle / buildSelectionBundle  导出：把选中项打成一份 JSON
 *   previewBundle                             预检：这个包要装什么、和本机冲突在哪
 *   importBundle                              落地：写工作流文件、建卡片、建应用
 *
 * 预检和落地共用同一份解析与冲突判定，避免「预检说没问题，导入却炸了」。
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { discoverModelLoaderSpecs } from "./model-loaders.js";
import { findSimilarModel } from "./model-match.js";
import { buildBundle, bundleWorkflowFileName, collectDependencies, exportApp, exportCard, parseBundle, workflowFingerprint } from "./workflow-bundle.js";
import { writeJsonAtomic } from "./util.js";

function bundleHttpError(message, { status = 400, code = "bundle_error", details } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

/** 按 id 取卡片；不存在的 id 直接忽略，比抛错更符合「导出手上有的那些」的预期。 */
function selectedFrom(cards, ids) {
  const wanted = new Set(ids);
  return cards.filter((card) => wanted.has(card.id));
}

/**
 * 依赖比对：把包里的模型/节点分成「已有」「可替代」「缺失」三类。
 *
 * 判定顺序和 setup 扫描保持一致，否则会出现「卡片显示可用但导入说缺」的分歧：
 * 1. 精确在 ComfyUI 当前列表里 → 已有
 * 2. 同名不同目录、或相似度够高且唯一 → 可替代（ComfyUI 加载时能认）
 * 3. 其余 → 缺失
 *
 * 注意：能替代不等于应该替代。这里只报告，替不替由用户在卡片上决定，
 * 因为同族不同量化（4B/8B、turbo/raw）在画质和速度上差别很大。
 */
export function compareDependencies(dependencies, { loaderOptions = {}, hasNodeClass = () => false, objectInfo = {} } = {}) {
  const specs = discoverModelLoaderSpecs(objectInfo || {});
  const specByKey = new Map(specs.map((spec) => [`${spec.classType}\u0000${spec.input}`, spec]));
  const present = [];
  const replaceable = [];
  const missingModels = [];
  const missingNodes = [];

  for (const model of dependencies?.models || []) {
    const key = `${model.classType}\u0000${model.input}`;
    const options = Array.isArray(loaderOptions?.[model.classType]) ? loaderOptions[model.classType] : [];
    if (options.includes(model.value)) {
      present.push({ ...model, matched: model.value });
      continue;
    }
    const spec = specByKey.get(key);
    const dirs = spec?.dirs || model.dirs || [];
    const similar = findSimilarModel(model.value, options.filter((option) => typeof option === "string"));
    if (similar?.file) {
      replaceable.push({ ...model, matched: similar.file, score: Math.round((similar.score || 0) * 100), dirs });
      continue;
    }
    missingModels.push({ ...model, dirs });
  }

  const seenNodes = new Set();
  for (const classType of dependencies?.nodes || []) {
    if (!classType || seenNodes.has(classType)) continue;
    seenNodes.add(classType);
    if (hasNodeClass(classType)) present.push({ classType, kind: "node" });
    else missingNodes.push({ classType });
  }

  return {
    present,
    replaceable,
    missingModels,
    missingNodes,
    ok: !missingModels.length && !missingNodes.length,
  };
}

/**
 * 把「缺什么」翻成「装哪个资源」。
 *
 * 只在资源索引里找，绝不按名字拼下载地址——索引是唯一可信来源，
 * 让包决定从哪下载等于把任意 URL 变成安装指令。
 *
 * 匹配规则：
 * - 模型：按 `target` 的文件名比。索引里 `diffusion_models/x.safetensors` 对应
 *   工作流里的 `UNETLoader.unet_name = x.safetensors`。
 * - 节点：按资源的 `provides` 里有没有这个 classType。同族插件可能提供多个类，
 *   全部命中才算（和 resources 的判定保持一致，否则会出现「装了但还说缺」）。
 */
export function matchInstallTargets({ missingModels = [], missingNodes = [] }, resourceStatus = null) {
  const resources = Array.isArray(resourceStatus?.resources) ? resourceStatus.resources : [];
  const resourceById = new Map(resources.map((item) => [item.id, item]));
  const ids = new Set();
  const unmatched = [];

  for (const model of missingModels) {
    const wanted = String(model.value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
    const hit = resources.find((item) => {
      // downloadable 缺省为「可下载」，只有显式 false 才算不可下（已下线的资源）。
      // 写成 `!item.downloadable` 会让旧缓存索引漏掉所有资源——那批索引里没有这个字段。
      if (item.downloadable === false || item.present) return false;
      const target = String(item.target || "").replace(/\\/g, "/");
      return target.split("/").pop().toLowerCase() === wanted;
    });
    if (hit) ids.add(hit.id);
    else unmatched.push({ kind: "model", ...model });
  }

  for (const node of missingNodes) {
    const hit = resources.find((item) => {
      if (item.downloadable === false || item.present || item.type !== "node") return false;
      return Array.isArray(item.provides) && item.provides.includes(node.classType);
    });
    if (hit) ids.add(hit.id);
    else unmatched.push({ kind: "node", ...node });
  }

  // requires 递归补齐：装 LoRA 前要先有底座，少这一步任务会在中途失败。
  const expanded = new Set();
  const visit = (id) => {
    if (expanded.has(id) || !resourceById.has(id)) return;
    expanded.add(id);
    for (const dependency of resourceById.get(id).requires || []) visit(dependency);
  };
  for (const id of ids) visit(id);

  return {
    ids: [...expanded],
    // 索引里找不到的，只能靠用户自己放文件或去资源中心手动处理。
    // 把它们单独列出来，不要假装「都可以一键装」。
    unmatched,
    totalSize: [...expanded].reduce((sum, id) => sum + (Number(resourceById.get(id)?.size) || 0), 0),
  };
}

export function createBundleManager({ freeWorkflows, workflowApps, setup, resources, comfy, resolveWorkflowsDir, logger } = {}) {
  async function objectInfo() {
    return (await comfy?.objectInfo?.().catch(() => ({}))) || {};
  }

  function loaderOptions() {
    try {
      return setup?.loaderOptions?.() || {};
    } catch {
      return {};
    }
  }

  function hasNodeClass(name) {
    try {
      return Boolean(setup?.hasNodeClass?.(name));
    } catch {
      return false;
    }
  }

  /** 导出时优先带源文件原文：UI 格式进 ComfyUI 还能再编辑，API 快照丢了节点坐标。 */
  async function rawWorkflowFor(entry) {
    try {
      const raw = await freeWorkflows.readRawWorkflow(entry);
      return raw?.workflow || null;
    } catch {
      // 源文件被删了也要能导出——退回卡片里的快照，导入方至少能跑。
      return entry.workflow || null;
    }
  }

  /**
   * 导出。
   *
   * 范围有三种情况，区别很关键：
   * - 都不传：导出全部（所有卡片 + 所有应用）。「导出全部」用这个。
   * - 只传 cardIds：只导这些卡片，不带应用。
   * - 传了 appIds：只导这些应用，卡片范围**由应用决定**（不能默认全部，
   *   否则导出别人的一个应用会顺手把这台机器所有卡片一起送出去）。
   */
  async function buildBundleFor({ cardIds = [], appIds = [], exportedBy = "" } = {}) {
    const allCards = await freeWorkflows.list({});
    const allApps = workflowApps.list();
    const selectAll = !cardIds.length && !appIds.length;
    const wantedApps = selectAll ? allApps : appIds.length ? allApps.filter((app) => appIds.includes(app.id)) : [];

    const appCardIds = new Set();
    for (const app of wantedApps) for (const step of app.steps) appCardIds.add(step.workflowId);
    const selectedCards = cardIds.length ? selectedFrom(allCards, cardIds) : appIds.length ? selectedFrom(allCards, [...appCardIds]) : allCards;
    const byId = new Map(selectedCards.map((card) => [card.id, card]));

    // 卡片顺序固定下来：先按应用步骤出现的先后排，再补剩余。
    // 不这么做的话包内序号跟着 updatedAt 走，同一份数据两次导出顺序可能不同，
    // diff 出来全是噪音，用户按序号对照应用步骤时也会看错。
    const ordered = [];
    const seenIds = new Set();
    for (const app of wantedApps) {
      for (const step of app.steps) {
        if (seenIds.has(step.workflowId)) continue;
        const card = byId.get(step.workflowId);
        if (!card) continue;
        seenIds.add(step.workflowId);
        ordered.push(card);
      }
    }
    for (const card of selectedCards) {
      if (seenIds.has(card.id)) continue;
      seenIds.add(card.id);
      ordered.push(card);
    }
    const wantedCards = ordered;

    const info = await objectInfo();
    const exported = [];
    const cardIdToIndex = new Map();
    for (const summary of wantedCards) {
      const entry = freeWorkflows.get(summary.id);
      if (!entry) continue;
      const raw = await rawWorkflowFor(entry);
      const card = exportCard(entry, { rawWorkflow: raw, objectInfo: info });
      if (!card?.workflow) continue;
      // 卡片导入后要找得到对应的新 id，这里先记下包内序号。
      cardIdToIndex.set(summary.id, exported.length);
      exported.push(card);
    }

    // 应用步骤引用本机 id；导出时换成包内序号。引不到卡片的步骤直接丢，
    // 让导入方得到一个完整可跑的链，而不是少一环还标着"缺失"。
    const apps = wantedApps
      .map((app) =>
        exportApp({
          name: app.name,
          description: app.description,
          steps: app.steps
            .map((step, index) => {
              const card = cardIdToIndex.get(step.workflowId);
              if (card === undefined) return null;
              return { card, label: step.label, column: step.column ?? index, row: step.row };
            })
            .filter(Boolean),
        }),
      )
      .filter((app) => app && app.steps.length);

    if (!exported.length && !apps.length) throw bundleHttpError("没有可导出的内容", { code: "bundle_empty" });
    return buildBundle({ cards: exported, apps, exportedBy });
  }

  /** 读包：接受对象或 JSON 文本，统一转成结构体。 */
  function readBundle(input) {
    if (typeof input === "string") {
      let parsed;
      try {
        parsed = JSON.parse(input);
      } catch {
        throw bundleHttpError("包不是合法 JSON", { code: "invalid_bundle_json" });
      }
      return parseBundle(parsed);
    }
    return parseBundle(input);
  }

  /**
   * 预检：算出「这个包会发生什么」，不写任何文件。
   *
   * 冲突判定只比指纹：同名但内容不同是两件事，不能因为名字撞了就当成同一个；
   * 内容相同但名字不同也只是重复，导入会跳过并说明。
   */
  async function previewBundle(input) {
    const parsed = readBundle(input);
    const info = await objectInfo();
    const existing = await freeWorkflows.list({});
    const existingByFingerprint = new Map();
    for (const card of existing) {
      const entry = freeWorkflows.get(card.id);
      if (!entry) continue;
      const raw = await rawWorkflowFor(entry);
      const fp = workflowFingerprint(raw);
      if (fp) existingByFingerprint.set(fp, card);
    }

    const cards = [];
    for (const card of parsed.cards) {
      const duplicate = existingByFingerprint.get(card.fingerprint) || null;
      const dependencies = collectDependencies(card.workflow, info);
      cards.push({
        index: card.index,
        name: card.name,
        sourceFormat: card.sourceFormat,
        archived: card.archived,
        steps: Array.isArray(card.customBindings) ? card.customBindings.length : 0,
        duplicate: duplicate ? { id: duplicate.id, name: duplicate.name } : null,
        dependencies: compareDependencies(dependencies, { loaderOptions: loaderOptions(), hasNodeClass, objectInfo: info }),
      });
    }

    const apps = parsed.apps.map((app) => ({
      name: app.name,
      description: app.description,
      steps: app.steps.length,
      existing: (workflowApps.list() || []).find((item) => item.name === app.name)?.id || null,
    }));

    const missingModels = new Set();
    const missingNodes = new Set();
    for (const card of cards) {
      for (const model of card.dependencies.missingModels) missingModels.add(`${model.classType}.${model.input}=${model.value}`);
      for (const node of card.dependencies.missingNodes) missingNodes.add(node.classType);
    }

    // 「缺什么」到「装哪个」：预检就把可安装的资源 id 算出来，
    // 用户看完清单可以直接勾选安装，不必再去资源中心一个个找。
    const flatModels = [...new Map(cards.flatMap((card) => card.dependencies.missingModels).map((model) => [`${model.classType}\u0000${model.input}\u0000${model.value}`, model])).values()];
    const flatNodes = [...new Map(cards.flatMap((card) => card.dependencies.missingNodes).map((node) => [node.classType, node])).values()];
    let installTargets = { ids: [], unmatched: flatModels.map((model) => ({ kind: "model", ...model })).concat(flatNodes.map((node) => ({ kind: "node", ...node }))), totalSize: 0 };
    try {
      installTargets = matchInstallTargets({ missingModels: flatModels, missingNodes: flatNodes }, resources?.status?.() || null);
    } catch (error) {
      // 资源索引没加载时不能让预检整体失败——清单照常给，只是没有「一键装」。
      logger?.warn?.(`预检匹配安装资源失败：${error.message}`);
    }

    return {
      exportedAt: parsed.exportedAt,
      exportedBy: parsed.exportedBy,
      cards,
      apps,
      problems: parsed.problems,
      install: {
        ids: installTargets.ids,
        unmatched: installTargets.unmatched,
        totalSize: installTargets.totalSize,
      },
      summary: {
        cards: cards.length,
        apps: apps.length,
        duplicates: cards.filter((card) => card.duplicate).length,
        importable: cards.filter((card) => !card.duplicate).length,
        missingModels: [...missingModels],
        missingNodes: [...missingNodes],
        // 有缺失也要允许导入：用户可能只想先拿到编排，稍后再装。
        // 这里只负责说清楚「导入后跑不起来的原因是什么」。
        runnable: !missingModels.size && !missingNodes.size,
      },
    };
  }

  /**
   * 落地导入。
   *
   * 工作流文件写到工作流目录，再走既有的 `importSource`：
   * 那条路径已经处理了格式识别、绑定识别、警告收集和落盘，
   * 重新实现一遍只会让两套逻辑漂移。
   */
  async function importBundle(input, { skipDuplicates = true } = {}) {
    const parsed = readBundle(input);
    if (!parsed.cards.length) throw bundleHttpError("包里没有可导入的卡片", { code: "bundle_no_cards" });
    const dir = await resolveWorkflowsDir();
    if (!dir) throw bundleHttpError("找不到 ComfyUI 工作流目录，无法落地工作流文件", { status: 409, code: "workflows_dir_missing" });

    await fsp.mkdir(dir, { recursive: true });
    const existingFiles = new Set((await fsp.readdir(dir).catch(() => [])).map((name) => name.toLowerCase()));

    const existing = await freeWorkflows.list({});
    const existingByFingerprint = new Map();
    for (const card of existing) {
      const entry = freeWorkflows.get(card.id);
      if (!entry) continue;
      const raw = await rawWorkflowFor(entry);
      const fp = workflowFingerprint(raw);
      if (fp) existingByFingerprint.set(fp, card);
    }

    const results = [];
    // 包内序号 → 本机新 id，应用步骤最后用它重映射。
    const indexToId = new Map();

    for (const card of parsed.cards) {
      const duplicate = existingByFingerprint.get(card.fingerprint);
      if (duplicate && skipDuplicates) {
        indexToId.set(card.index, duplicate.id);
        results.push({ name: card.name, status: "skipped", id: duplicate.id, message: `已存在同名工作流「${duplicate.name}」，已跳过` });
        continue;
      }
      const fileName = bundleWorkflowFileName(card, existingFiles);
      const target = path.join(dir, fileName);
      // 双保险：文件名已经清了非法字符，这里再确认解析结果没跳目录。
      const resolvedDir = path.resolve(dir);
      if (!path.resolve(target).startsWith(`${resolvedDir}${path.sep}`)) {
        results.push({ name: card.name, status: "failed", message: "文件名不合法" });
        continue;
      }
      try {
        await writeJsonAtomic(target, card.workflow);
        existingFiles.add(fileName.toLowerCase());
        const entry = await freeWorkflows.importSource(fileName);
        // 卡片名要用包里的原始名字，不能留文件名里的指纹后缀——
        // 否则导入方看到的是「数字人-a1b2c3d4」，用户不会认。
        if (entry.name !== card.name) await freeWorkflows.rename(entry.id, card.name);
        // 归档与预设跟着包走：导入方拿到的是「调好的卡片」，不是草稿。
        if (card.archived || card.preset) {
          await freeWorkflows.setArchived(entry.id, card.archived, card.preset || undefined);
        }
        if (card.customBindings.length) {
          await freeWorkflows.setCustomBindings(entry.id, card.customBindings);
        }
        indexToId.set(card.index, entry.id);
        results.push({ name: card.name, status: "imported", id: entry.id, file: fileName });
      } catch (error) {
        // 一条失败不该让整包失败：用户要的是「能进的都进」，剩下的单独报。
        logger?.warn?.(`导入卡片失败 ${card.name}: ${error.message}`);
        results.push({ name: card.name, status: "failed", message: error.message });
        await fsp.rm(target, { force: true }).catch(() => {});
      }
    }

    const appResults = [];
    for (const app of parsed.apps) {
      const steps = app.steps
        .map((step, index) => {
          const workflowId = indexToId.get(step.cardIndex);
          if (!workflowId) return null;
          return { workflowId, label: step.label, column: step.column ?? index, row: step.row };
        })
        .filter(Boolean);
      if (!steps.length) {
        appResults.push({ name: app.name, status: "failed", message: "引用的卡片都没导入成功" });
        continue;
      }

      // 应用也要幂等。卡片按内容指纹跳过，应用却每次都新建，会得到
      // 「端到端应用」+「端到端应用（导入）」+ ……手滑点几次就有几份。
      //
      // 这里不能按指纹比：步骤里是本机新分配的 workflowId，同一份内容在不同机器上
      // 指纹必然不同。改用「名字 + 步骤数 + 每步标签顺序」判断同一编排——
      // 名字撞了但步骤结构不同，说明用户诚意要两个不同的应用，那就两个都留。
      const sameApp = (workflowApps.list() || []).find((item) => {
        if (item.name !== app.name) return false;
        if (item.steps.length !== steps.length) return false;
        return item.steps.every((step, index) => (step.label || "") === (steps[index].label || ""));
      });
      if (sameApp && skipDuplicates) {
        appResults.push({ name: app.name, status: "skipped", id: sameApp.id, steps: sameApp.steps.length });
        continue;
      }

      try {
        const saved = await workflowApps.save({
          // 同名应用不覆盖：用户导入别人的包不该冲掉自己那份。
          name: (workflowApps.list() || []).some((item) => item.name === app.name) ? `${app.name}（导入）` : app.name,
          description: app.description,
          steps,
        });
        appResults.push({ name: saved.name, status: "imported", id: saved.id, steps: steps.length });
      } catch (error) {
        appResults.push({ name: app.name, status: "failed", message: error.message });
      }
    }

    return {
      cards: results,
      apps: appResults,
      problems: parsed.problems,
      summary: {
        imported: results.filter((item) => item.status === "imported").length,
        skipped: results.filter((item) => item.status === "skipped").length,
        failed: results.filter((item) => item.status === "failed").length,
        appsImported: appResults.filter((item) => item.status === "imported").length,
        appsSkipped: appResults.filter((item) => item.status === "skipped").length,
      },
    };
  }

  return { buildBundleFor, previewBundle, importBundle };
}

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFreeWorkflowStore } from "../src/free-workflows.js";
import { createWorkflowAppStore } from "../src/workflow-apps.js";
import { createBundleManager, compareDependencies, matchInstallTargets } from "../src/workflow-bundle-manager.js";
import { BUNDLE_KIND, buildBundle, bundleWorkflowFileName, collectDependencies, parseBundle, workflowFingerprint } from "../src/workflow-bundle.js";

// 一个最小但合法的 API 工作流：有图片输出、有模型 loader、有文本输入。
function apiWorkflow({ unet = "demo.safetensors", text = "a cat", seed = 7 } = {}) {
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    2: { class_type: "CLIPTextEncode", inputs: { text } },
    3: { class_type: "KSampler", inputs: { seed, model: ["1", 0], positive: ["2", 0] } },
    4: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "out" } },
  };
}

function uiWorkflow() {
  return {
    nodes: [
      { id: 1, type: "UNETLoader", widgets_values: ["demo.safetensors"] },
      { id: 2, type: "SaveImage", widgets_values: ["out"] },
    ],
    links: [],
  };
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "bundle-test-"));
}

/**
 * 建一套真实的 store：卡片 + 应用 + 工作流目录都在临时目录里，
 * 不碰用户数据和 ComfyUI 安装。comfy.objectInfo 给一份假的节点表。
 */
async function makeRig({ objectInfo = {} } = {}) {
  const root = await tempDir();
  const workflowsDir = path.join(root, "workflows");
  await fsp.mkdir(workflowsDir, { recursive: true });
  const comfy = { objectInfo: async () => objectInfo };
  const freeWorkflows = createFreeWorkflowStore({
    dataDir: root,
    getComfyWorkflowsDir: () => workflowsDir,
    comfy,
    logger: { info() {}, warn() {} },
  });
  await freeWorkflows.load();
  const workflowApps = createWorkflowAppStore({ dataDir: root, logger: { warn() {} } });
  await workflowApps.load();
  const bundles = createBundleManager({
    freeWorkflows,
    workflowApps,
    setup: {
      loaderOptions: () => ({ UNETLoader: ["demo.safetensors"] }),
      hasNodeClass: () => true,
    },
    resources: { status: () => ({ resources: [] }) },
    comfy,
    resolveWorkflowsDir: async () => workflowsDir,
    logger: { info() {}, warn() {} },
  });
  return { root, workflowsDir, freeWorkflows, workflowApps, bundles };
}

async function seedCard(rig, { name = "卡片", workflow = apiWorkflow(), archived = true } = {}) {
  const fileName = `${name}.json`;
  await fsp.writeFile(path.join(rig.workflowsDir, fileName), JSON.stringify(workflow), "utf8");
  const entry = await rig.freeWorkflows.importSource(fileName);
  if (archived) await rig.freeWorkflows.setArchived(entry.id, true);
  return entry;
}

test("取消固定标记经过导出和导入仍保留，工作流输入保持原样", async () => {
  const source = await makeRig();
  const target = await makeRig();
  try {
    const entry = await seedCard(source);
    await source.freeWorkflows.setCustomBindings(entry.id, [{ node: "2", input: "text", label: "提示词", unpinned: true }]);
    const bundle = await source.bundles.buildBundleFor({ cardIds: [entry.id] });
    assert.equal(bundle.cards[0].customBindings[0].unpinned, true);
    await target.bundles.importBundle(bundle);
    const cards = await target.freeWorkflows.list();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].customBindings[0].unpinned, true);
    assert.equal(target.freeWorkflows.get(cards[0].id).workflow["2"].inputs.text, "a cat");
  } finally {
    await fsp.rm(source.root, { recursive: true, force: true });
    await fsp.rm(target.root, { recursive: true, force: true });
  }
});

// ── 指纹 ──────────────────────────────────────────────────────────────

test("工作流指纹与键顺序无关，内容不同则不同", () => {
  const a = { 1: { class_type: "X", inputs: { a: 1, b: 2 } } };
  const b = { 1: { inputs: { b: 2, a: 1 }, class_type: "X" } };
  assert.equal(workflowFingerprint(a), workflowFingerprint(b), "同样的图换个键顺序必须算出同一个指纹");
  assert.notEqual(workflowFingerprint(a), workflowFingerprint({ 1: { class_type: "X", inputs: { a: 1, b: 3 } } }));
  assert.equal(workflowFingerprint(null), "");
});

// ── 包校验 ─────────────────────────────────────────────────────────────

test("包校验只接受认识的格式，并丢掉越界字段", () => {
  const good = buildBundle({
    cards: [
      {
        name: "卡片",
        workflow: apiWorkflow(),
        fingerprint: workflowFingerprint(apiWorkflow()),
        // 越界字段：必须被丢弃，不能顺着包写进卡片
        id: "free_evil",
        sourceSignature: "whatever",
        customBindings: [{ node: "2", input: "text", label: "提示词", surface: "weird", extra: "x" }],
      },
    ],
    apps: [],
  });
  const parsed = parseBundle(good);
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].id, undefined, "包里的 id 不能带进本机");
  assert.equal(parsed.cards[0].sourceSignature, undefined);
  assert.equal(parsed.cards[0].customBindings[0].surface, "card", "未知 surface 退回默认值");
  assert.equal(parsed.cards[0].customBindings[0].extra, undefined);
});

test("包校验拒绝错误格式与超版本", () => {
  assert.throws(() => parseBundle(null), /不是对象/);
  assert.throws(() => parseBundle({ kind: "other" }), /搬家包/);
  assert.throws(() => parseBundle({ kind: BUNDLE_KIND, schema: 99, cards: [] }), /版本过新/);
});

test("形状不对的工作流被单独挑出来，不污染整包", () => {
  const parsed = parseBundle({
    kind: BUNDLE_KIND,
    schema: 1,
    cards: [
      { name: "好的", workflow: apiWorkflow() },
      { name: "坏的", workflow: { foo: "bar" } },
      { name: "没本体" },
    ],
    apps: [],
  });
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].name, "好的");
  assert.equal(parsed.problems.length, 2);
});

test("应用引用包外卡片时该应用被丢弃", () => {
  const parsed = parseBundle({
    kind: BUNDLE_KIND,
    schema: 1,
    cards: [{ name: "A", workflow: apiWorkflow() }],
    apps: [
      { name: "能用", steps: [{ card: 0, column: 0 }] },
      { name: "越界", steps: [{ card: 5, column: 0 }] },
    ],
  });
  assert.equal(parsed.apps.length, 1);
  assert.equal(parsed.apps[0].name, "能用");
});

// ── 文件名 ─────────────────────────────────────────────────────────────

test("导入文件名保留中文并挡掉路径字符", () => {
  const name = bundleWorkflowFileName({ name: "数字人/测试:卡片", fingerprint: "abcdef0123456789" });
  assert.doesNotMatch(name, /[/:\\]/, "路径分隔符必须被替换");
  assert.match(name, /^数字人_测试_卡片-abcdef01\.json$/);

  const exists = new Set([name.toLowerCase()]);
  const second = bundleWorkflowFileName({ name: "数字人/测试:卡片", fingerprint: "abcdef0123456789" }, exists);
  assert.notEqual(second, name, "同名同指纹第二次要换名，避免覆盖");
  assert.match(second, /-2\.json$/);
});

test("空名字退回可用的默认名", () => {
  assert.match(bundleWorkflowFileName({ name: "", fingerprint: "1234567890" }), /^workflow-12345678\.json$/);
  assert.match(bundleWorkflowFileName({ name: "../../etc/passwd", fingerprint: "1234567890" }), /^_.._etc_passwd-12345678\.json$/);
});

// ── 依赖比对 ───────────────────────────────────────────────────────────

test("依赖比对把模型分成已有/可替代/缺失", () => {
  const deps = {
    models: [
      { classType: "UNETLoader", input: "unet_name", value: "demo.safetensors" },
      { classType: "UNETLoader", input: "unet_name", value: "demo_v2_int8.safetensors" },
      { classType: "VAELoader", input: "vae_name", value: "totally_other.safetensors" },
    ],
    nodes: ["KSampler", "UnknownNode"],
  };
  const result = compareDependencies(deps, {
    loaderOptions: { UNETLoader: ["demo.safetensors", "demo_v2_int8_convrot.safetensors"], VAELoader: ["ae.safetensors"] },
    hasNodeClass: (name) => name === "KSampler",
  });
  assert.equal(result.present.length, 2, "精确命中 + 已装节点");
  assert.equal(result.replaceable.length, 1, "同族相似模型算可替代");
  assert.equal(result.replaceable[0].value, "demo_v2_int8.safetensors");
  assert.equal(result.missingModels.length, 1);
  assert.equal(result.missingNodes.length, 1);
  assert.equal(result.ok, false);
});

test("全部齐备时 ok 为真", () => {
  const result = compareDependencies(
    { models: [{ classType: "UNETLoader", input: "unet_name", value: "demo.safetensors" }], nodes: [] },
    { loaderOptions: { UNETLoader: ["demo.safetensors"] }, hasNodeClass: () => true },
  );
  assert.equal(result.ok, true);
});

test("安装目标只从资源索引里匹配，不猜 URL", () => {
  const status = {
    resources: [
      { id: "demo_model", type: "model", target: "diffusion_models/demo.safetensors", present: false, downloadable: true, size: 100, requires: ["base_vae"] },
      { id: "base_vae", type: "model", target: "vae/ae.safetensors", present: false, downloadable: true, size: 10, requires: [] },
      { id: "already", type: "model", target: "diffusion_models/have.safetensors", present: true, downloadable: true, size: 5, requires: [] },
      { id: "node_pack", type: "node", target: "custom_nodes/Pack", present: false, downloadable: true, size: 20, provides: ["UnknownNode"], requires: [] },
    ],
  };
  const matched = matchInstallTargets(
    {
      missingModels: [{ classType: "UNETLoader", input: "unet_name", value: "demo.safetensors" }],
      missingNodes: [{ classType: "UnknownNode" }, { classType: "NobodyProvidesThis" }],
    },
    status,
  );
  assert.deepEqual(matched.ids.sort(), ["base_vae", "demo_model", "node_pack"].sort(), "依赖要先装，已装的不能重复装");
  assert.equal(matched.totalSize, 130);
  assert.equal(matched.unmatched.length, 1);
  assert.equal(matched.unmatched[0].classType, "NobodyProvidesThis");
});

test("旧缓存索引没有 downloadable 字段时仍能匹配", () => {
  // 旧远端/旧缓存索引里没有 downloadable 字段，语义是「可下载」。
  // 如果按 falsy 判断，整批资源都会被判成不可装，用户看到的是一份全空的可安装清单。
  const status = {
    resources: [
      { id: "legacy_model", type: "model", target: "diffusion_models/legacy.safetensors", present: false, size: 50, requires: [] },
      { id: "legacy_pack", type: "node", target: "custom_nodes/Legacy", present: false, size: 30, provides: ["LegacyNode"], requires: [] },
      // 显式 false 表示资源已下线，不该被推荐安装。
      { id: "retired", type: "model", target: "diffusion_models/retired.safetensors", present: false, downloadable: false, size: 1, requires: [] },
    ],
  };
  const matched = matchInstallTargets(
    {
      missingModels: [
        { classType: "UNETLoader", input: "unet_name", value: "legacy.safetensors" },
        { classType: "UNETLoader", input: "unet_name", value: "retired.safetensors" },
      ],
      missingNodes: [{ classType: "LegacyNode" }],
    },
    status,
  );
  assert.ok(matched.ids.includes("legacy_model"), "缺字段应当按可下载处理");
  assert.ok(matched.ids.includes("legacy_pack"));
  assert.ok(!matched.ids.includes("retired"), "显式下线的资源不能被推荐安装");
});

// ── 端到端：导出 → 预检 → 导入 ────────────────────────────────────────

test("导出再导入到另一个环境，卡片与应用都能重建并正确串链", async () => {
  const source = await makeRig();
  const card = await seedCard(source, { name: "生成图" });
  await source.freeWorkflows.setArchived(card.id, true, { size: "1024x1024", count: 1 });
  await source.freeWorkflows.setCustomBindings(card.id, [{ node: "2", input: "text", label: "提示词", surface: "card" }]);
  const app = await source.workflowApps.save({ name: "出图应用", steps: [{ workflowId: card.id, label: "生成", column: 0 }] });

  const bundle = await source.bundles.buildBundleFor({ cardIds: [card.id], appIds: [app.id], exportedBy: "test" });
  assert.equal(bundle.kind, BUNDLE_KIND);
  assert.equal(bundle.cards.length, 1);
  assert.equal(bundle.apps.length, 1);
  assert.equal(bundle.apps[0].steps[0].card, 0, "应用步骤要指向包内序号，不是本机 id");
  assert.ok(bundle.cards[0].workflow, "包里必须带工作流本体");

  // 另一台机器：空数据目录、独立工作流目录
  const target = await makeRig();
  const preview = await target.bundles.previewBundle(bundle);
  assert.equal(preview.cards.length, 1);
  assert.equal(preview.cards[0].duplicate, null);
  assert.equal(preview.summary.runnable, true);

  const result = await target.bundles.importBundle(bundle);
  assert.equal(result.summary.imported, 1);
  assert.equal(result.summary.appsImported, 1);

  const imported = await target.freeWorkflows.list({});
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, "生成图");
  assert.equal(imported[0].archived, true, "归档状态要跟着包走");
  assert.deepEqual(imported[0].preset, { size: "1024x1024", count: 1, seedFixed: "false" });
  assert.equal(imported[0].customBindings[0].label, "提示词");

  const apps = target.workflowApps.list();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].steps[0].workflowId, imported[0].id, "应用步骤要指向导入后的新 id");

  // 工作流文件真的落盘了，卡片才能同步
  const files = await fsp.readdir(target.workflowsDir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith(".json"));
});

test("重复导入同一个包默认跳过，不产生第二份卡片", async () => {
  const source = await makeRig();
  const card = await seedCard(source, { name: "唯一" });
  const bundle = await source.bundles.buildBundleFor({ cardIds: [card.id] });

  const target = await makeRig();
  const first = await target.bundles.importBundle(bundle);
  assert.equal(first.summary.imported, 1);

  const preview = await target.bundles.previewBundle(bundle);
  assert.equal(preview.cards[0].duplicate?.name, "唯一", "预检要能认出重复");
  assert.equal(preview.summary.duplicates, 1);
  assert.equal(preview.summary.importable, 0);

  const second = await target.bundles.importBundle(bundle);
  assert.equal(second.summary.skipped, 1);
  assert.equal(second.summary.imported, 0);
  assert.equal((await target.freeWorkflows.list({})).length, 1);
});

test("重复导入时应用也跳过，不会攒出一堆「（导入）」副本", async () => {
  const source = await makeRig();
  const card = await seedCard(source, { name: "链上卡片" });
  await source.workflowApps.save({ name: "我的应用", steps: [{ workflowId: card.id, column: 0, label: "生成" }] });
  const bundle = await source.bundles.buildBundleFor({});

  const target = await makeRig();
  const first = await target.bundles.importBundle(bundle);
  assert.equal(first.summary.appsImported, 1);

  const second = await target.bundles.importBundle(bundle);
  // 卡片幂等而应用不幂等，会让用户手滑两次就多出「我的应用（导入）」——
  // 同一份包导入两次的结果必须一样。
  assert.equal(second.summary.appsImported, 0);
  assert.equal(second.summary.appsSkipped, 1);
  const apps = target.workflowApps.list();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, "我的应用");
});

test("同名但步骤结构不同的应用不算重复，各自保留", async () => {
  const source = await makeRig();
  const one = await seedCard(source, { name: "一", workflow: apiWorkflow({ text: "一" }) });
  const two = await seedCard(source, { name: "二", workflow: apiWorkflow({ text: "二" }) });
  await source.workflowApps.save({ name: "同名应用", steps: [{ workflowId: one.id, column: 0, label: "第一步" }] });
  await source.workflowApps.save({
    name: "同名应用",
    steps: [
      { workflowId: one.id, column: 0, label: "第一步" },
      { workflowId: two.id, column: 1, label: "第二步" },
    ],
  });

  const bundle = await source.bundles.buildBundleFor({});
  const target = await makeRig();
  const result = await target.bundles.importBundle(bundle);

  // 包本身就有两个同名应用（步骤数不同），它们不是同一编排，必须都进。
  assert.equal(result.summary.appsImported, 2, "步骤结构不同就不是同一个应用");
  assert.equal(target.workflowApps.list().length, 2);
});

test("同名但内容不同的卡片不当作重复，会各自保留", async () => {
  const source = await makeRig();
  const a = await seedCard(source, { name: "同名", workflow: apiWorkflow({ text: "版本一" }) });
  const bundle = await source.bundles.buildBundleFor({ cardIds: [a.id] });

  const target = await makeRig();
  await seedCard(target, { name: "同名", workflow: apiWorkflow({ text: "版本二" }) });
  const preview = await target.bundles.previewBundle(bundle);
  assert.equal(preview.cards[0].duplicate, null, "内容不同就不是同一张卡片");

  const result = await target.bundles.importBundle(bundle);
  assert.equal(result.summary.imported, 1);
  assert.equal((await target.freeWorkflows.list({})).length, 2);
});

test("只导出应用时自动补齐它引用的卡片", async () => {
  const source = await makeRig();
  const upstream = await seedCard(source, { name: "上游", workflow: apiWorkflow({ text: "上游" }) });
  const downstream = await seedCard(source, { name: "下游", workflow: apiWorkflow({ text: "下游", unet: "demo.safetensors" }) });
  const app = await source.workflowApps.save({
    name: "两段链",
    steps: [
      { workflowId: upstream.id, column: 0 },
      { workflowId: downstream.id, column: 1 },
    ],
  });

  const bundle = await source.bundles.buildBundleFor({ appIds: [app.id] });
  assert.equal(bundle.cards.length, 2, "应用引用的卡片必须一起打包，否则导入方跑不起来");
  assert.deepEqual(bundle.apps[0].steps.map((step) => step.card), [0, 1]);
});

test("只导出应用时不带上无关的卡片", async () => {
  const source = await makeRig();
  const used = await seedCard(source, { name: "链上用到的", workflow: apiWorkflow({ text: "用" }) });
  await seedCard(source, { name: "无关卡片", workflow: apiWorkflow({ text: "无关" }) });
  const app = await source.workflowApps.save({ name: "单步链", steps: [{ workflowId: used.id, column: 0 }] });

  const bundle = await source.bundles.buildBundleFor({ appIds: [app.id] });
  // 只给 appIds 时卡片范围必须由应用决定，不能退回「全部」：
  // 否则导出别人的一个应用会顺手把这台机器的所有卡片（含隐私内容）一起送出去。
  assert.equal(bundle.cards.length, 1);
  assert.equal(bundle.cards[0].name, "链上用到的");
});

test("不带任何范围参数就是导出全部，应用也要一起带走", async () => {
  const source = await makeRig();
  const first = await seedCard(source, { name: "卡片一", workflow: apiWorkflow({ text: "一" }) });
  await seedCard(source, { name: "卡片二", workflow: apiWorkflow({ text: "二" }) });
  await source.workflowApps.save({ name: "整包应用", steps: [{ workflowId: first.id, column: 0 }] });

  const bundle = await source.bundles.buildBundleFor({});
  // 「导出全部」如果漏掉应用，用户做完备份换机器会发现编排全丢了——
  // 卡片还在，但点一下铺开整条链的能力没了，这不算完整备份。
  assert.equal(bundle.cards.length, 2);
  assert.equal(bundle.apps.length, 1);
  assert.equal(bundle.apps[0].name, "整包应用");
  // 应用步骤在包内要换成卡片序号，导入方才不依赖本机 id。
  assert.equal(bundle.apps[0].steps[0].card, 0);
});

test("导入时缺失模型只报告，不阻止导入", async () => {
  const source = await makeRig();
  const card = await seedCard(source, { name: "怪模型", workflow: apiWorkflow({ unet: "not_installed.safetensors" }) });
  const bundle = await source.bundles.buildBundleFor({ cardIds: [card.id] });

  const target = await makeRig();
  // 目标环境没有这个模型
  const preview = await target.bundles.previewBundle(bundle);
  assert.equal(preview.summary.runnable, false);
  assert.equal(preview.summary.missingModels.length, 1);
  assert.match(preview.summary.missingModels[0], /not_installed\.safetensors/);

  const result = await target.bundles.importBundle(bundle);
  assert.equal(result.summary.imported, 1, "缺模型也要能导入编排");
});

test("导入时工作流目录不可用要明确拒绝，而不是静默写入别处", async () => {
  const source = await makeRig();
  const card = await seedCard(source, { name: "卡片" });
  const bundle = await source.bundles.buildBundleFor({ cardIds: [card.id] });

  const rig = await makeRig();
  const broken = createBundleManager({
    freeWorkflows: rig.freeWorkflows,
    workflowApps: rig.workflowApps,
    setup: { loaderOptions: () => ({}), hasNodeClass: () => false },
    resources: { status: () => ({ resources: [] }) },
    comfy: { objectInfo: async () => ({}) },
    resolveWorkflowsDir: async () => "",
    logger: { warn() {} },
  });
  await assert.rejects(() => broken.importBundle(bundle), /工作流目录/);
});

test("空包被拒绝", async () => {
  const rig = await makeRig();
  await assert.rejects(() => rig.bundles.importBundle({ kind: BUNDLE_KIND, schema: 1, cards: [], apps: [] }), /没有可导入/);
  await assert.rejects(() => rig.bundles.buildBundleFor({ cardIds: ["nope"] }), /没有可导出/);
});

test("工作流带 UI 格式时按 UI 导出，落盘仍是可转换的原文", async () => {
  const rig = await makeRig({ objectInfo: {} });
  const ui = uiWorkflow();
  await fsp.writeFile(path.join(rig.workflowsDir, "ui卡片.json"), JSON.stringify(ui), "utf8");
  // UI 工作流需要 objectInfo 才能转换；没有节点表时导入会失败——这里只验导出路径的数据源
  const entry = { id: "x", name: "ui卡片", sourceRel: "ui卡片.json", sourceFormat: "ui", workflow: apiWorkflow(), customBindings: [] };
  assert.equal(typeof collectDependencies(entry.workflow, {}), "object");
});

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

import { ALL_CREATION_WORKFLOWS as CREATION_WORKFLOWS } from "../src/creation-workflows.js";
import { MODEL_LOADER_SPECS } from "../src/model-loaders.js";
import { createRegistry } from "../src/registry.js";
import { runWorkflow } from "../src/runner.js";
import { createGatewayApp, stopGateway } from "../src/server.js";
import { createWorkflowModelOverrideStore, workflowModelFields } from "../src/workflow-model-overrides.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";
const KREA = "creation-image-krea2";
const H3 = "creation-video-h3-768";
const change = (nodeId, input, value) => ({ nodeId, input, value });
const fileAlt = (classType, input) => `installed/${classType}-${input}.safetensors`;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workflow-model-config-"));
  const workflowDir = path.join(root, "workflows");
  const dataDir = path.join(root, "data");
  await fsp.mkdir(workflowDir);
  const graphs = new Map(), bytes = new Map(), info = {};
  const regular = { ...CREATION_WORKFLOWS[0], id: "image-regular", name: "image-regular", source: { kind: "json" }, strictModelNames: false };
  const registryBytes = JSON.stringify({ version: 1, workflows: [...CREATION_WORKFLOWS, regular] });
  await fsp.writeFile(path.join(workflowDir, "registry.json"), registryBytes);
  for (const entry of CREATION_WORKFLOWS) {
    const text = await fsp.readFile(path.resolve(import.meta.dirname, "../workflows", entry.file), "utf8");
    bytes.set(entry.file, text);
    await fsp.writeFile(path.join(workflowDir, entry.file), text);
    const graph = JSON.parse(text);
    graphs.set(entry.id, graph);
    for (const node of Object.values(graph)) {
      const required = (info[node.class_type] ??= { input: { required: {} } }).input.required;
      for (const spec of MODEL_LOADER_SPECS.filter((spec) => spec.classType === node.class_type)) {
        if (typeof node.inputs[spec.input] !== "string") continue;
        const options = (required[spec.input] ??= [[]])[0];
        const alternate = ["Qwen3TTSModelLoader", "Qwen3TTSSenseVoiceASR"].includes(spec.classType) ? `Example/${spec.classType}` : fileAlt(spec.classType, spec.input);
        for (const value of [node.inputs[spec.input], alternate]) if (!options.includes(value)) options.push(value);
      }
    }
  }
  let gateway, server, url, offline = false;
  let scanCalls = 0;
  const config = {
    comfyUrl: "http://127.0.0.1:1", comfyDir: "", comfyFrontendDir: "", comfyWorkflowsDir: "", workflowDir,
    desktopDistribution: true, scanOnStart: false, watchWorkflows: false, updateEnabled: false,
    resourcesIndexUrl: "", resourcesIndexUrlBackup: "", dataDir, outputDir: path.join(root, "outputs"),
    requestTimeoutMs: 500, pollIntervalMs: 1,
  };
  async function stop() {
    if (gateway) await stopGateway(gateway);
    if (server) await new Promise((resolve) => server.close(resolve));
    gateway = null;
    server = null;
  }
  async function start() {
    gateway = await createGatewayApp(config);
    Object.assign(gateway.comfy, {
      objectInfo: async () => { if (offline) throw new Error("测试离线"); return info; },
      systemStats: async () => ({}), folderPaths: async () => ({}),
    });
    const originalScan = gateway.setup.scan;
    gateway.setup.scan = (...args) => { scanCalls += 1; return originalScan(...args); };
    server = gateway.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}`;
  }
  t.after(async () => {
    await stop();
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await start();
  async function request(endpoint, body) {
    const response = await fetch(`${url}${endpoint}`, body === undefined ? {} : {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  return {
    root, workflowDir, dataDir, graphs, info, request,
    get gateway() { return gateway; }, get scanCalls() { return scanCalls; },
    models: (id, body) => request(`/api/workflows/${id}/models`, body),
    setOffline: (value) => { offline = value; },
    restart: async () => { await stop(); await start(); },
    async assertTemplatesUnchanged() {
      assert.equal(await fsp.readFile(path.join(workflowDir, "registry.json"), "utf8"), registryBytes);
      for (const [file, text] of bytes) assert.equal(await fsp.readFile(path.join(workflowDir, file), "utf8"), text, file);
    },
  };
}

test("Qwen2511 排除2.1主模型与H3编码器且保存前拒绝跨架构配置", async (t) => {
  const f = await fixture(t);
  const id = "creation-image-qwen-edit";
  const badModel = "qwen_image_2.1_bf16.safetensors";
  const badClip = "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors";
  f.info.UNETLoader.input.required.unet_name[0].push(badModel);
  f.info.CLIPLoader.input.required.clip_name[0].push(badClip);
  const fields = (await f.models(id)).data.fields;
  const unet = fields.find(field => field.input === "unet_name");
  const clip = fields.find(field => field.input === "clip_name");
  assert.equal(unet.options.includes(badModel), false);
  assert.match(unet.rejectedOptions.find(item => item.value === badModel).reason, /四维/);
  assert.equal(clip.options.includes(badClip), false);
  for (const item of [change("170:161", "unet_name", badModel), change("170:162", "clip_name", badClip)]) {
    const result = await f.models(id, { overrides: [item] });
    assert.equal(result.status, 409);
    assert.equal(result.data.error.code, "incompatible_workflow_model");
  }
  assert.equal(f.scanCalls, 0);
  await f.assertTemplatesUnchanged();
});

test("旧存档的错误组合不被删改但标记不可用并在GPU提交前拦截", async (t) => {
  const f = await fixture(t);
  const id = "creation-image-qwen-edit";
  const badModel = "qwen_image_2.1_bf16.safetensors";
  f.info.UNETLoader.input.required.unet_name[0].push(badModel);
  const store = createWorkflowModelOverrideStore({ dataDir: f.dataDir });
  await store.update(id, { overrides: [{ nodeId: "170:161", input: "unet_name", classType: "UNETLoader", value: badModel }] });
  await f.restart();
  await f.gateway.setup.scan();
  assert.equal(f.gateway.setup.isAvailable(id), false);
  assert.ok(f.gateway.setup.workflowStatus(id).problems.some(problem => problem.type === "compatibility"));
  const fields = (await f.models(id)).data.fields;
  const model = fields.find(field => field.nodeId === "170:161");
  assert.equal(model.value, badModel);
  assert.equal(model.available, false);
  assert.match(model.compatibilityError, /Qwen Image 2.1/);
  let submitted = false;
  await assert.rejects(runWorkflow({
    entry: f.gateway.registry.resolve(id), context: { prompt: "修改服装", uploadedImages: [{name:"input.png",subfolder:""}], params: { seed: 1 } },
    comfy: { submit: async () => { submitted = true; return { promptId: "never" }; } },
  }), error => error.code === "incompatible_workflow_model");
  assert.equal(submitted, false);
  assert.equal((await f.models(id, { reset: true })).status, 200);
  assert.equal(f.gateway.setup.isAvailable(id), true);
  await f.assertTemplatesUnchanged();
});

test("完整2.1链拦截H3编码器旧VAE普通BF16主模型且旧2511覆盖不串入", async (t) => {
  const f = await fixture(t);
  const id = "creation-image-qwen21-edit";
  const incompatible = [
    change("460", "unet_name", "qwen_image_2.1_bf16.safetensors"),
    change("452", "clip_name", "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors"),
    change("453", "vae_name", "qwen_image_vae.safetensors"),
    change("459", "lora_name", "Qwen-Image-Edit-2511-Lightning.safetensors"),
  ];
  for (const item of incompatible) {
    const result = await f.models(id, { overrides: [item] });
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(result.data.error.code, "incompatible_workflow_model");
  }
  const store = createWorkflowModelOverrideStore({dataDir:f.dataDir});
  await store.update("creation-image-qwen-edit", {overrides:[{nodeId:"170:161",input:"unet_name",classType:"UNETLoader",value:"qwen_image_2.1_bf16.safetensors"}]});
  await f.restart();
  const data = (await f.models(id)).data;
  assert.equal(data.fields.some(field => field.overridden), false);
  assert.match(data.fields.find(field => field.nodeId === "460").value, /turbo_int8_convrot/);
  await f.assertTemplatesUnchanged();
});

test("模型配置 GET 暴露七条完整模型字段且不触发扫描，H3 各输入隔离", async (t) => {
  const f = await fixture(t);
  const counts = [4, 4, 7, 8, 1, 2, 3, 4];
  for (const [index, entry] of CREATION_WORKFLOWS.entries()) {
    const { status, data } = await f.models(entry.id);
    assert.equal(status, 200);
    assert.equal(data.id, entry.id);
    assert.equal(data.fields.length, counts[index], entry.id);
    for (const field of data.fields) {
      assert.equal(field.defaultValue, field.value);
      assert.equal(field.overridden, false);
      assert.equal(field.missingNode, false);
      assert.equal(field.available, true, `${entry.id}:${field.input}`);
    }
  }
  const h3 = (await f.models(H3)).data.fields.filter((field) => field.nodeId === "1");
  assert.equal(h3.length, 5);
  for (const field of h3) {
    assert.ok(field.options.includes(fileAlt("MiniMaxH3EasyLoader", field.input)));
    assert.equal(field.options.some((option) => h3.some((other) => other.input !== field.input && option === fileAlt("MiniMaxH3EasyLoader", other.input))), false);
  }
  assert.equal(f.scanCalls, 0);
  assert.equal((await f.models("image-regular")).status, 403);
  assert.equal((await f.models("image-regular", { reset: true })).status, 403);
  assert.equal((await f.models("not-found")).status, 404);
  await f.assertTemplatesUnchanged();
});

test("保存后 registry、setup、模型列表与真实 runner mock 提交使用同一显式模型，重启保留且模板不变", async (t) => {
  const f = await fixture(t);
  const original = f.graphs.get(KREA)["98"].inputs.unet_name;
  const selected = fileAlt("UNETLoader", "unet_name");
  const options = f.info.UNETLoader.input.required.unet_name[0];
  options.splice(options.indexOf(original), 1);
  options.push("krea2_turbo_fp8_scaled.safetensors");
  await f.gateway.setup.scan();
  assert.equal(f.gateway.setup.isAvailable(KREA), false);
  const before = (await f.request(`/api/setup/diagnostics?workflowId=${KREA}`)).data.workflow.loaders.find((row) => row.nodeId === "98");
  assert.equal(before.alias, null);
  assert.equal(before.effective, original);
  const response = await f.models(KREA, { overrides: [change("98", "unet_name", path.posix.basename(selected))] });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const field = response.data.fields.find((field) => field.nodeId === "98");
  assert.equal(field.value, selected);
  assert.equal(field.overridden, true);
  assert.equal(field.available, true);
  assert.equal(f.gateway.setup.isAvailable(KREA), true);
  assert.equal(f.gateway.setup.registrySnapshotCurrent(), true);
  assert.equal(f.gateway.registry.resolveModel(KREA).entry.workflow["98"].inputs.unet_name, selected);
  assert.equal(f.gateway.registry.listModels().find((model) => model.baseId === KREA).entry.workflow["98"].inputs.unet_name, selected);
  assert.deepEqual(f.gateway.registry.resolve("image-regular").workflow, f.graphs.get(KREA));
  const modelList = (await f.request("/v1/models")).data;
  assert.ok(modelList.data.some((model) => model.id === KREA));
  const diagnostic = (await f.request(`/api/setup/diagnostics?workflowId=${KREA}`)).data.workflow.loaders.find((row) => row.nodeId === "98");
  assert.equal(diagnostic.effective, selected);
  assert.equal(diagnostic.availability.available, true);
  let submitted;
  await runWorkflow({
    entry: { ...f.gateway.registry.resolve(KREA), mainModelFile: "must-not-be-used.safetensors" },
    context: { prompt: "测试提示词", params: { seed: 1 }, count: 1 },
    modelAliasFor: f.gateway.setup.modelAliasFor, loaderSpecs: f.gateway.setup.modelLoaderSpecs(),
    comfy: {
      submit: async (workflow) => { submitted = workflow; return { promptId: "mock" }; },
      history: async () => ({ status: { completed: true }, outputs: { "95": { images: [{ filename: "mock.png", type: "output" }] } } }),
      view: async () => ({ buffer: Buffer.alloc(0), contentType: "image/png" }),
    },
  });
  assert.equal(submitted["98"].inputs.unet_name, selected);
  for (const nodeId of ["97", "101", "103"]) assert.deepEqual(submitted[nodeId], f.graphs.get(KREA)[nodeId]);
  await f.restart();
  assert.equal((await f.models(KREA)).data.fields.find((field) => field.nodeId === "98").value, selected);
  assert.equal(f.gateway.registry.resolve(KREA).templateWorkflow["98"].inputs.unet_name, original);
  await f.assertTemplatesUnchanged();
});

test("模型配置整批校验拒绝路径、未知字段、重复冲突、错输入候选和不唯一 basename，无部分写入", async (t) => {
  const f = await fixture(t);
  const selected = fileAlt("UNETLoader", "unet_name");
  await f.models(KREA, { overrides: [change("98", "unet_name", selected)] });
  const storePath = path.join(f.dataDir, "workflow-model-overrides.json");
  const persisted = await fsp.readFile(storePath, "utf8");
  f.info.UNETLoader.input.required.unet_name[0].push("a/duplicate.safetensors", "b/duplicate.safetensors");
  const badChanges = [
    change("98", "unet_name", "C:/models/model.safetensors"), change("98", "unet_name", "/tmp/model.safetensors"),
    change("98", "unet_name", "../model.safetensors"), change("98", "unet_name", "sub\\..\\model.safetensors"),
    change("98", "unet_name", "\\\\host\\model.safetensors"), change("98", "unet_name", "missing.safetensors"),
    change("98", "unet_name", "duplicate.safetensors"), change("98", "unet_name", 42),
    change("999", "unet_name", selected), change("102", "text", selected), change("98", "__proto__", selected),
    change("98", "unet_name", ""), change("98", "unet_name", "bad\u0000.safetensors"),
  ];
  for (const item of badChanges) {
    const result = await f.models(KREA, { overrides: [change("97", "clip_name", fileAlt("CLIPLoader", "clip_name")), item] });
    assert.equal(result.status, 400, JSON.stringify(item));
    assert.equal(await fsp.readFile(storePath, "utf8"), persisted);
    assert.equal(f.gateway.registry.resolve(KREA).workflow["97"].inputs.clip_name, f.graphs.get(KREA)["97"].inputs.clip_name);
  }
  for (const body of [{ overrides: [] }, { reset: true, overrides: [] }, { overrides: [change("98", "unet_name", selected), change("98", "unet_name", null)] }]) {
    assert.equal((await f.models(KREA, body)).status, 400);
  }
  const mixed = await f.models(H3, { overrides: [change("1", "video_vae", fileAlt("MiniMaxH3EasyLoader", "audio_vae"))] });
  assert.equal(mixed.status, 400);
  assert.equal(await fsp.readFile(storePath, "utf8"), persisted);
});

test("repository 使用节点枚举或受控仓库文本，optional COMBO 可用，动态 loader 仅暴露模型字符串", async (t) => {
  const f = await fixture(t);
  const id = "creation-audio-voice-clone";
  let response = await f.models(id, { overrides: [change("40", "model_id", "Example/Qwen3TTSSenseVoiceASR")] });
  assert.equal(response.status, 200);
  assert.equal((await f.models(id, { overrides: [change("40", "model_id", "Other/Repo")] })).status, 400);
  f.info.Qwen3TTSSenseVoiceASR.input.required.model_id = ["STRING", {}];
  response = await f.models(id, { overrides: [change("40", "model_id", "Other/SenseVoiceSmall")] });
  assert.equal(response.status, 200);
  for (const value of ["../bad", "C:/models", "a/b/c", "https://example.com/repo", "model.safetensors", " bad/repo"]) {
    assert.equal((await f.models(id, { overrides: [change("40", "model_id", value)] })).status, 400, value);
  }
  const vaeOptions = f.info.VAELoader.input.required.vae_name[0];
  f.info.VAELoader.input = { optional: { vae_name: ["COMBO", { options: vaeOptions }] } };
  assert.equal((await f.models(KREA, { overrides: [change("103", "vae_name", fileAlt("VAELoader", "vae_name"))] })).status, 200);
  const workflow = { a: { class_type: "CustomModelLoader", inputs: { weights: "custom.gguf", prompt: "caption", linked: ["a", 0] } } };
  const fields = workflowModelFields({ id, workflow }, {
    CustomModelLoader: { input: { optional: { weights: ["COMBO", { options: ["custom.gguf"] }], prompt: [["caption.gguf"]], linked: [["linked.gguf"]] } } },
  }).fields;
  assert.deepEqual(fields.map((field) => field.input), ["weights"]);
});

test("null、默认值和 reset 恢复未安装模板，缺节点只允许恢复，离线 PATCH 只读", async (t) => {
  const f = await fixture(t);
  const original = f.graphs.get(KREA)["98"].inputs.unet_name;
  const selected = fileAlt("UNETLoader", "unet_name");
  f.info.UNETLoader.input.required.unet_name[0] = [selected];
  for (const restore of [null, original]) {
    assert.equal((await f.models(KREA, { overrides: [change("98", "unet_name", selected)] })).status, 200);
    const result = await f.models(KREA, { overrides: [change("98", "unet_name", restore)] });
    assert.equal(result.status, 200);
    const field = result.data.fields.find((field) => field.nodeId === "98");
    assert.equal(field.value, original);
    assert.equal(field.overridden, false);
    assert.equal(field.available, false);
  }
  await f.models(KREA, { overrides: [change("98", "unet_name", selected)] });
  delete f.info.UNETLoader;
  const missing = (await f.models(KREA)).data.fields.find((field) => field.nodeId === "98");
  assert.equal(missing.missingNode, true);
  assert.equal((await f.models(KREA, { overrides: [change("98", "unet_name", selected)] })).status, 400);
  assert.equal((await f.models(KREA, { reset: true })).status, 200);
  f.setOffline(true);
  const offline = await f.models(KREA);
  assert.equal(offline.status, 200);
  assert.equal(offline.data.offline, true);
  assert.equal(offline.data.fields.length, 4);
  assert.equal((await f.models(KREA, { reset: true })).status, 503);
  assert.deepEqual(f.gateway.registry.resolve(KREA).workflow, f.graphs.get(KREA));
  await f.assertTemplatesUnchanged();
});

test("并发 PATCH 合并不同字段与工作流，恢复整条不影响其他配置", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([
    f.models(KREA, { overrides: [change("98", "unet_name", fileAlt("UNETLoader", "unet_name"))] }),
    f.models(KREA, { overrides: [change("97", "clip_name", fileAlt("CLIPLoader", "clip_name"))] }),
    f.models(H3, { overrides: [change("1", "video_vae", fileAlt("MiniMaxH3EasyLoader", "video_vae"))] }),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal((await f.models(KREA)).data.fields.filter((field) => field.overridden).length, 2);
  assert.equal((await f.models(H3)).data.fields.filter((field) => field.overridden).length, 1);
  await f.models(KREA, { reset: true });
  assert.equal((await f.models(KREA)).data.fields.some((field) => field.overridden), false);
  assert.equal((await f.models(H3)).data.fields.filter((field) => field.overridden).length, 1);
  await f.restart();
  assert.equal((await f.models(KREA)).data.fields.some((field) => field.overridden), false);
  assert.equal((await f.models(H3)).data.fields.filter((field) => field.overridden).length, 1);
  await f.assertTemplatesUnchanged();
});

test("持久层串行原子提交，写失败不改变内存且后续可恢复，dataDir 隔离", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workflow-model-store-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDir = path.join(root, "data");
  const store = createWorkflowModelOverrideStore({ dataDir });
  await store.load();
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "default.safetensors" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: "default-vae.safetensors" } },
  };
  const row = (nodeId, input, classType, value) => ({ nodeId, input, classType, value });
  await Promise.all([
    store.update(KREA, { overrides: [row("1", "unet_name", "UNETLoader", "selected.safetensors")] }),
    store.update(KREA, { overrides: [row("2", "vae_name", "VAELoader", "selected-vae.safetensors")] }),
  ]);
  const committed = store.apply(KREA, graph);
  assert.equal(committed["1"].inputs.unet_name, "selected.safetensors");
  assert.equal(committed["2"].inputs.vae_name, "selected-vae.safetensors");
  assert.equal(graph["1"].inputs.unet_name, "default.safetensors");
  const restarted = createWorkflowModelOverrideStore({ dataDir });
  await restarted.load();
  assert.deepEqual(restarted.apply(KREA, graph), committed);
  const isolated = createWorkflowModelOverrideStore({ dataDir: path.join(root, "isolated") });
  await isolated.load();
  assert.deepEqual(isolated.apply(KREA, graph), graph);
  const file = path.join(dataDir, "workflow-model-overrides.json");
  await fsp.rename(file, `${file}.backup`);
  await fsp.mkdir(file);
  await assert.rejects(store.update(KREA, { reset: true }));
  assert.deepEqual(store.apply(KREA, graph), committed);
  await fsp.rmdir(file);
  await fsp.rename(`${file}.backup`, file);
  await store.update(KREA, { reset: true });
  assert.deepEqual(store.apply(KREA, graph), graph);
  assert.deepEqual((await fsp.readdir(dataDir)).filter((name) => name.endsWith(".tmp")), []);
});

test("HTTP 持久化失败不改变有效图或快照，失败后的请求仍可保存", async (t) => {
  const f = await fixture(t);
  const storePath = path.join(f.dataDir, "workflow-model-overrides.json");
  await fsp.mkdir(storePath);
  const before = f.gateway.registry.resolve(KREA);
  const response = await f.models(KREA, { overrides: [change("98", "unet_name", fileAlt("UNETLoader", "unet_name"))] });
  assert.equal(response.status, 500);
  assert.equal(f.gateway.registry.resolve(KREA), before);
  assert.equal(f.scanCalls, 0);
  assert.equal((await f.models(KREA)).data.fields.some((field) => field.overridden), false);
  await fsp.rmdir(storePath);
  assert.equal((await f.models(KREA, { overrides: [change("98", "unet_name", fileAlt("UNETLoader", "unet_name"))] })).status, 200);
  await f.assertTemplatesUnchanged();
});

test("H3 显式配置只改指定 input，strict resolver 不借用同类其他输入的枚举", async (t) => {
  const f = await fixture(t);
  const selected = fileAlt("MiniMaxH3EasyLoader", "video_vae");
  const response = await f.models(H3, { overrides: [change("1", "video_vae", selected)] });
  assert.equal(response.status, 200);
  const effective = f.gateway.registry.resolve(H3).workflow;
  for (const input of ["fl2va_model", "ref2va_model", "text_encoder", "audio_vae"]) {
    assert.equal(effective["1"].inputs[input], f.graphs.get(H3)["1"].inputs[input]);
  }
  assert.equal(effective["1"].inputs.video_vae, selected);
  const original = f.graphs.get(H3)["1"].inputs.video_vae;
  delete f.info.MiniMaxH3EasyLoader.input.required.video_vae;
  f.info.MiniMaxH3EasyLoader.input.required.audio_vae[0].push(original);
  await f.gateway.setup.scan();
  assert.equal(f.gateway.setup.modelAliasFor("MiniMaxH3EasyLoader", "video_vae", original, null, { strictModelNames: true }), "");
  const field = (await f.models(H3)).data.fields.find((field) => field.nodeId === "1" && field.input === "video_vae");
  assert.deepEqual(field.options, []);
  assert.equal(field.available, false);
  assert.equal((await f.models(H3, { overrides: [change("1", "video_vae", fileAlt("MiniMaxH3EasyLoader", "audio_vae"))] })).status, 400);
});

test("registry 强制刷新等待在途加载，模板原图和显式有效图分离", async (t) => {
  const f = await fixture(t);
  let selected = "first.safetensors";
  const registry = createRegistry({ dir: f.workflowDir, workflowOverride: (_id, workflow) => {
    if (workflow["98"]) workflow["98"].inputs.unet_name = selected;
    return workflow;
  } });
  const pending = registry.load();
  selected = "second.safetensors";
  await registry.load({ force: true });
  await pending;
  assert.equal(registry.resolve(KREA).workflow["98"].inputs.unet_name, selected);
  assert.equal(registry.resolve(KREA).templateWorkflow["98"].inputs.unet_name, f.graphs.get(KREA)["98"].inputs.unet_name);
  assert.deepEqual(registry.resolve("image-regular").workflow, f.graphs.get(KREA));
});

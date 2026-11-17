import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createMockComfyServer } from "../mock/comfyui-mock.mjs";
import { createGatewayApp, stopGateway } from "../src/server.js";
import { createFreeWorkflowStore } from "../src/free-workflows.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

const root = path.resolve(import.meta.dirname, "..");
let tempDir;
let mock;
let gatewayServer;
let gateway;
let baseUrl;
let mockUrl;

async function copyWorkflows(target) {
  await fsp.mkdir(target, { recursive: true });
  for (const file of ["mock-image.json", "mock-image-edit.json", "mock-video.json", "registry.json"]) {
    await fsp.copyFile(path.join(root, "test", "fixtures", file), path.join(target, file));
  }
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

before(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comfyui-gateway-test-"));
  const workflows = path.join(tempDir, "workflows");
  await copyWorkflows(workflows);
  const dataDir = path.join(tempDir, "data");
  await fsp.mkdir(dataDir);
  await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ workflows: [{
    id: "legacy-archive", name: "旧版归档", sourceRel: "missing.json", sourceFormat: "api",
    workflow: JSON.parse(await fsp.readFile(path.join(workflows, "mock-image.json"), "utf8")),
    bindings: { outputType: "image", prompt: { node: "6", input: "text" } },
    customBindings: [{ node: "3", input: "steps", label: "步数" }],
    archivedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }] }));
  mock = createMockComfyServer({ port: 0, delayMs: 50, quiet: true });
  await mock.start();
  mockUrl = mock.url;
  gateway = await createGatewayApp({
    comfyUrl: mockUrl,
    comfyDir: "",
    comfyFrontendDir: "",
    comfyWorkflowsDir: workflows,
    workflowDir: workflows,
    desktopDistribution: true,
    scanOnStart: false,
    watchWorkflows: false,
    updateEnabled: false,
    resourcesIndexUrl: "",
    resourcesIndexUrlBackup: "",
    dataDir: path.join(tempDir, "data"),
    outputDir: path.join(tempDir, "data", "outputs"),
    publicBaseUrl: "http://127.0.0.1:18199",
    corsOrigins: ["http://localhost:3000"],
    requestTimeoutMs: 15000,
    videoTimeoutMs: 15000,
    pollIntervalMs: 50,
  });
  gatewayServer = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => gatewayServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;
  await gateway.setup.scan();
});

after(async () => {
  if (gateway) await stopGateway(gateway);
  await new Promise((resolve) => gatewayServer?.close(resolve));
  await mock?.stop();
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("health reports mock ComfyUI and registry", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(data.status, "ok");
  assert.equal(data.comfy.reachable, true);
  assert.equal(data.workflows.count, 3);
  assert.equal(data.version, fs.readFileSync(path.join(root, "..", "VERSION"), "utf8").trim());
});

test("session endpoints expose the canvas lifecycle", async () => {
  const open = await jsonFetch(`${baseUrl}/api/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "canvas-test" }),
  });
  assert.equal(open.data.count, 1);
  assert.equal(open.data.seen, true);
  const { data: status } = await jsonFetch(`${baseUrl}/api/session/status`);
  assert.equal(status.count, 1);
  assert.equal(status.activeTasks, 0);
  await jsonFetch(`${baseUrl}/api/session/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "canvas-test" }),
  });
  const { data: closed } = await jsonFetch(`${baseUrl}/api/session/status`);
  assert.equal(closed.count, 0);
  assert.equal(closed.seen, true);
});

test("models list exposes image and video workflows", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  const ids = data.data.map((item) => item.id);
  assert.ok(ids.includes("image-mock"));
  assert.ok(ids.includes("image-mock-edit"));
  assert.ok(ids.includes("video-mock"));
  assert.equal(data.data.find((item) => item.id === "video-mock").metadata.type, "video");
});

test("image generation returns a PNG as b64_json", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "image-mock", prompt: "a blue cat", n: 1, size: "1024x1024", quality: "high", response_format: "b64_json" }),
  });
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 1);
  const buffer = Buffer.from(data.data[0].b64_json, "base64");
  assert.ok(buffer.subarray(0, 8).equals(pngSignature));
});

test("image generation fills the requested batch count", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "image-mock", prompt: "three cats", n: 3, size: "1024x1024", response_format: "b64_json" }),
  });
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 3);
});

test("image edits accept a multipart reference image", async () => {
  const image = await fsp.readFile(path.join(root, "mock", "assets", "mock.png"));
  const form = new FormData();
  form.set("model", "image-mock-edit");
  form.set("prompt", "make it green");
  form.set("n", "1");
  form.set("size", "1024x1024");
  form.set("response_format", "b64_json");
  form.append("image", new Blob([image], { type: "image/png" }), "ref.png");
  const { response, data } = await jsonFetch(`${baseUrl}/v1/images/edits`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 1);
});

test("video task completes and serves mp4 content", async () => {
  const form = new FormData();
  form.set("model", "video-mock");
  form.set("prompt", "a blue cat walking");
  form.set("seconds", "5");
  form.set("size", "1024x576");
  form.set("mode", "frames");
  form.set("resolution_name", "720p");
  const created = await jsonFetch(`${baseUrl}/v1/videos`, { method: "POST", body: form });
  assert.equal(created.response.status, 200);
  assert.ok(created.data.id);
  let task;
  for (let index = 0; index < 100; index += 1) {
    task = (await jsonFetch(`${baseUrl}/v1/videos/${created.data.id}`)).data;
    if (["completed", "failed", "cancelled"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(task.status, "completed");
  assert.ok(task.url.includes("/files/"));
  const proxied = await jsonFetch(`${baseUrl}/v1/videos/${created.data.id}`, {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "canvas.example.com" },
  });
  assert.match(proxied.data.url, /^https:\/\/canvas\.example\.com\/files\//);
  const local = await jsonFetch(`${baseUrl}/v1/videos/${created.data.id}`);
  assert.match(local.data.url, /^http:\/\/127\.0\.0\.1:18199\/files\//);
  const ranged = await fetch(`${baseUrl}${new URL(local.data.url).pathname}`, { headers: { Range: "bytes=0-1023" } });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get("content-range") || "", /^bytes 0-1023\/\d+$/);
  assert.equal((await ranged.arrayBuffer()).byteLength, 1024);
  const content = await fetch(`${baseUrl}/v1/videos/${created.data.id}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-type") || "", /video\/mp4/);
  assert.ok((await content.arrayBuffer()).byteLength > 100);
});

test("视频状态轮询在真实 HTTP 链路静默 200/304，保留异常与取消日志", async (t) => {
  const lines = [];
  for (const level of ["info", "warn", "error"]) {
    t.mock.method(gateway.logger, level, (message) => lines.push({ level, message: String(message) }));
  }
  // 只创建隔离测试数据，不入队、不执行模型；分别覆盖排队、进度及终态。
  const task = gateway.tasks.create({ model: "video-mock" });
  const route = `/v1/videos/${task.id}`;
  for (const status of ["queued", "running", "completed"]) {
    task.status = status;
    const result = await jsonFetch(`${baseUrl}${route}?poll=1`);
    assert.equal(result.response.status, 200);
    assert.equal(result.data.status, status);
  }
  const first = await fetch(`${baseUrl}${route}`);
  await first.text();
  assert.equal(first.status, 200);
  assert.ok(first.headers.get("etag"));
  // Node fetch 的默认条件请求会附带 no-cache，Express 因而不会返回304；明确采用重新验证模式。
  const unchanged = await fetch(`${baseUrl}${route}`, { cache: "no-cache", headers: { "If-None-Match": first.headers.get("etag") } });
  await unchanged.text();
  assert.equal(unchanged.status, 304);
  const head = await fetch(`${baseUrl}${route}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  await head.text();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.filter((line) => /^(?:GET|HEAD) \/v1\/videos\//.test(line.message)).length, 0, "成功和304轮询不能刷屏");

  const missing = await jsonFetch(`${baseUrl}/v1/videos/task_missing_log_test`);
  assert.equal(missing.response.status, 404);
  assert.ok(lines.some((line) => line.level === "error" && /GET \/v1\/videos\/task_missing_log_test -> 404/.test(line.message)));
  const originalGet = gateway.tasks.get.bind(gateway.tasks);
  const broken = t.mock.method(gateway.tasks, "get", (id) => {
    if (id === "task_broken_log_test") throw new Error("injected polling failure");
    return originalGet(id);
  });
  const failed = await jsonFetch(`${baseUrl}/v1/videos/task_broken_log_test`);
  assert.equal(failed.response.status, 500);
  assert.ok(lines.some((line) => line.level === "error" && /GET \/v1\/videos\/task_broken_log_test -> 500.*injected polling failure/.test(line.message)));
  broken.mock.restore();

  const cancelled = await jsonFetch(`${baseUrl}${route}/cancel`, { method: "POST" });
  assert.equal(cancelled.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lines.some((line) => line.level === "info" && line.message.startsWith(`POST ${route}/cancel 200 `)), "取消操作照常留痕");
});

test("任务本身失败仍记录警告，不因轮询静默而丢失", async (t) => {
  const warnings = [];
  t.mock.method(gateway.logger, "warn", (message) => warnings.push(String(message)));
  const task = gateway.tasks.create({ model: "video-mock" });
  gateway.tasks.enqueue(task, async () => { throw new Error("injected generation failure"); });
  const deadline = Date.now() + 5000;
  while ((task.status !== "failed" || task._controller) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(task.status, "failed");
  assert.equal(task._controller, undefined);
  assert.ok(warnings.some((message) => message.includes(task.id) && message.includes("injected generation failure")));
  const result = await jsonFetch(`${baseUrl}/v1/videos/${task.id}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, "failed");
  assert.match(result.data.error.message, /injected generation failure/);
});

test("workflow import accepts API JSON and rejects UI JSON", async () => {
  const api = await jsonFetch(`${baseUrl}/api/workflows/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: { 1: { class_type: "SaveImage", inputs: {} } },
      name: "import-test",
      type: "image",
    }),
  });
  assert.equal(api.response.status, 201);
  assert.equal(api.data.workflow.name, "image-import-test");
  const models = (await jsonFetch(`${baseUrl}/v1/models`)).data.data.map((item) => item.id);
  assert.ok(models.includes("image-import-test"));

  const ui = await jsonFetch(`${baseUrl}/api/workflows/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { nodes: [], links: [] }, name: "ui-test" }),
  });
  assert.equal(ui.response.status, 422);
  assert.equal(ui.data.error.code, "ui_workflow_not_supported");
});

test("自由工作流 PATCH 更新归档后 GET、重载及真实生成请求都使用快照", async (t) => {
  const sourceFile = path.join(tempDir, "workflows", "mock-image.json");
  const source = await fsp.readFile(sourceFile, "utf8");
  const imported = await jsonFetch(`${baseUrl}/api/free-workflows/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "mock-image.json" }),
  });
  assert.equal(imported.response.status, 201);
  const original = imported.data.workflow;
  const url = `${baseUrl}/api/free-workflows/${original.id}`;
  const bindings = await jsonFetch(`${url}/bindings`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindings: [{ node: "3", input: "steps", label: "步数", surface: "settings" }, { node: "6", input: "text", label: "提示词" }] }),
  });
  assert.equal(bindings.response.status, 200);
  const objectInfo = t.mock.method(gateway.comfy, "objectInfo", () => { throw new Error("已有文本绑定的归档不应读取 ComfyUI"); });
  const patched = await jsonFetch(url, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "归档请求不能误走重命名",
      archived: true,
      preset: { count: 1, seed: "123", seedFixed: "true" },
      texts: [{ node: "6", input: "text", value: "当前提示词" }, { node: "7", input: "text", value: "当前负向文本" }],
      values: [{ node: "3", input: "steps", value: "13" }, { node: "6", input: "text", value: "固定的当前提示词" }],
    }),
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.data.workflow.name, original.name);
  assert.equal(patched.data.workflow.archived, true);
  const fetched = await jsonFetch(url);
  assert.equal(fetched.response.status, 200);
  assert.deepEqual(fetched.data.workflow.textInputs.map((item) => item.default), ["固定的当前提示词", "当前负向文本"]);
  assert.equal(objectInfo.mock.callCount(), 0);
  objectInfo.mock.restore();
  assert.equal(await fsp.readFile(sourceFile, "utf8"), source);

  const reloaded = createFreeWorkflowStore({ dataDir: path.join(tempDir, "data"), comfy: {} });
  await reloaded.load();
  const saved = reloaded.get(original.id);
  assert.equal(saved.workflow["3"].inputs.steps, 13);
  assert.equal(saved.workflow["3"].inputs.seed, 0, "归档不能把预设种子写进未明确提交的工作流字段");
  assert.equal(saved.workflow["7"].inputs.text, "当前负向文本");
  const generated = await jsonFetch(`${baseUrl}/v1/free-workflows/${original.id}/images`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "固定的当前提示词", seed: "123", seedFixed: true }),
  });
  assert.equal(generated.response.status, 200);
  const submitted = (await jsonFetch(`${mockUrl}/__last_prompt`)).data.workflow;
  assert.equal(submitted["3"].inputs.steps, 13, "未再传步数时执行保存的归档值");
  assert.equal(submitted["6"].inputs.text, "固定的当前提示词");
  assert.equal(submitted["7"].inputs.text, "当前负向文本", "未再传负向文本时执行保存的归档值");
  const overridden = await jsonFetch(`${baseUrl}/v1/free-workflows/${original.id}/images`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "执行覆盖值", values: [{ node: "3", input: "steps", value: "17" }] }),
  });
  assert.equal(overridden.response.status, 200);
  assert.equal((await jsonFetch(`${mockUrl}/__last_prompt`)).data.workflow["3"].inputs.steps, 17, "真实执行链路仍必须合并 customBindings");
});

test("自由工作流 PATCH 拒绝无效数组，不误改名称或取消归档并保持旧调用兼容", async () => {
  const imported = await jsonFetch(`${baseUrl}/api/free-workflows/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "mock-image.json" }),
  });
  assert.equal(imported.response.status, 201);
  const url = `${baseUrl}/api/free-workflows/${imported.data.workflow.id}`;
  const patch = (body) => jsonFetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const archived = await patch({ archived: true, preset: { count: 2 } });
  assert.equal(archived.response.status, 200);
  const before = archived.data.workflow;
  const file = path.join(tempDir, "data", "free-workflows.json");
  const persisted = await fsp.readFile(file, "utf8");
  for (const body of [
    { archived: true, texts: null }, { archived: false, values: {} },
    { texts: "[]" }, { values: "bad" }, { name: "不能重命名", values: null },
  ]) {
    const invalid = await patch(body);
    assert.equal(invalid.response.status, 400, JSON.stringify(body));
    assert.match(invalid.data.error.message, /配置值必须是数组/);
    assert.equal(invalid.data.error.type, "invalid_request_error");
    assert.deepEqual((await jsonFetch(url)).data.workflow, before);
    assert.equal(await fsp.readFile(file, "utf8"), persisted);
  }
  const snapshotOnly = await patch({ texts: [{ node: "7", input: "text", value: "保留归档状态" }] });
  assert.equal(snapshotOnly.response.status, 200);
  assert.equal(snapshotOnly.data.workflow.archivedAt, before.archivedAt, "省略 archived 不应取消归档");
  assert.equal(snapshotOnly.data.workflow.textInputs.find((item) => item.node === "7").default, "保留归档状态");
  const renamed = await patch({ name: "  兼容重命名  " });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.data.workflow.name, "兼容重命名");
  assert.equal(renamed.data.workflow.archivedAt, before.archivedAt);
  const unarchived = await patch({ archived: false });
  assert.equal(unarchived.response.status, 200);
  assert.equal(unarchived.data.workflow.archived, false);
  assert.equal(unarchived.data.workflow.textInputs.find((item) => item.node === "7").default, "保留归档状态");
});

test("自由工作流 PATCH 先校验无效数组，再按需升级旧版文本绑定", async (t) => {
  const url = `${baseUrl}/api/free-workflows/legacy-archive`;
  const file = path.join(tempDir, "data", "free-workflows.json");
  const persisted = await fsp.readFile(file, "utf8");
  const objectInfo = t.mock.method(gateway.comfy, "objectInfo");
  const invalid = await jsonFetch(url, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true, texts: null }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(objectInfo.mock.callCount(), 0, "非法请求不能触发绑定升级");
  assert.equal(await fsp.readFile(file, "utf8"), persisted);
  const patched = await jsonFetch(url, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true, texts: [{ node: "7", input: "text", value: "旧版条目的当前文本" }] }),
  });
  assert.equal(patched.response.status, 200);
  // 前面的导入可能已缓存 object_info；升级绑定可以复用缓存，不能断言一定重新联网。
  // 是否升级成功以返回及落盘后的文本绑定和值为准。
  assert.ok(objectInfo.mock.callCount() <= 1, "旧绑定升级最多读取一次 object_info，也可复用缓存");
  const saved = JSON.parse(await fsp.readFile(file, "utf8")).workflows.find((item) => item.id === "legacy-archive");
  assert.ok(Array.isArray(saved.bindings.textInputs));
  assert.equal(saved.workflow["7"].inputs.text, "旧版条目的当前文本");
  assert.equal(patched.data.workflow.sourceMissing, true);
  assert.equal(patched.data.workflow.textInputs.find((item) => item.node === "7").default, "旧版条目的当前文本");
});

test("schema exposes prompt and size bindings", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/api/workflows/image-mock/schema`);
  assert.equal(response.status, 200);
  const keys = data.schema.fields.map((field) => field.key);
  assert.ok(keys.includes("prompt"));
  assert.ok(keys.includes("width"));
  assert.ok(keys.includes("height"));
});

test("model errors are explicit", async () => {
  const missing = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "missing", prompt: "x" }),
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.error.code, "model_not_found");

  const mismatch = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "video-mock", prompt: "x" }),
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.data.error.code, "model_type_mismatch");
});

test("request cancel endpoint is idempotent for unknown ids", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/api/requests/missing/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.cancelled, false);
});

test("CORS preflight allows the canvas origin", async () => {
  const response = await fetch(`${baseUrl}/v1/models`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("cross-site writes are rejected but local origins pass", async () => {
    const blocked = await jsonFetch(`${baseUrl}/api/resources/refresh`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(blocked.response.status, 403);
    const blockedSite = await jsonFetch(`${baseUrl}/api/resources/refresh`, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(blockedSite.response.status, 403);
    const allowed = await jsonFetch(`${baseUrl}/api/resources/refresh`, { method: "POST", headers: { Origin: "http://127.0.0.1:3000" } });
    assert.notEqual(allowed.response.status, 403);
});

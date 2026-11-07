import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { createKvmemRuntime } from "../src/kvmem-runtime.js";

const image = "data:image/png;base64,aGVsbG8=";
const input = { imageDataUrl: image, systemPrompt: "private system prompt", userPrompt: "private user prompt" };
const config = { enabled: true, installDir: path.resolve("fake-install"), modelPath: path.resolve("private-model.ninfer"),
  gpuDevice: "GPU-selected", startupTimeoutMs: 200, requestTimeoutMs: 200 };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ fetchRoute, spawnError, spawnEventError, closes = true, overrides = {}, configuration = {} } = {}) {
  const children = [], requests = [], logs = [];
  let id, key;
  const runtime = createKvmemRuntime({
    config: { ...config, ...configuration }, logger: { warn: (...args) => logs.push(args) },
    fileExists: () => true, freePort: async () => 46123, pollIntervalMs: 1, probeTimeoutMs: 30, stopTimeoutMs: 8,
    spawnImpl(exe, argv, options) {
      if (spawnError) throw Error("raw secret spawn failure");
      id = argv[argv.indexOf("--model-id") + 1];
      key = argv[argv.indexOf("--api-key") + 1];
      const child = new EventEmitter();
      Object.assign(child, { pid: 123, exe, argv, options, kills: [], closed: false, closes });
      child.finish = (code = 0) => { if (!child.closed) { child.closed = true; child.emit("close", code); } };
      child.kill = (signal) => { child.kills.push(signal); if (child.closes) setImmediate(() => child.finish()); return true; };
      children.push(child);
      if (spawnEventError) setImmediate(() => { child.emit("error", Error("raw error")); child.finish(1); });
      return child;
    },
    async fetchImpl(url, options) {
      const route = new URL(url).pathname;
      requests.push({ url, options, route });
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(options.redirect, "error");
      const context = { route, options, id, children, requests };
      if (fetchRoute) {
        const result = await fetchRoute(context);
        if (result !== undefined) return result;
      }
      if (route === "/health") return json({ status: "ok" });
      if (route === "/v1/models") return json({ object: "list", data: [{ id }] });
      if (route === "/props") return json({ backend: "ninfer", modalities: { vision: true } });
      if (route === "/v1/chat/completions") return json({ model: id, choices: [{ message: { content: "  A red square.  " }, finish_reason: "stop" }] });
      throw Error("unexpected route");
    },
    ...overrides,
  });
  return { runtime, children, requests, logs };
}

async function waitFor(testCondition) {
  for (let n = 0; n < 100 && !testCondition(); n++) await tick();
  assert.ok(testCondition(), "expected fake operation was reached");
}

test("capability is synchronous, explicit opt-in, checks paths without spawning", () => {
  const h = harness();
  assert.deepEqual(h.runtime.capability(), { id: "kvmem", label: "KVMem / NInfer", enabled: true, available: true,
    visionMode: "cpu", reasons: [], missingResources: [], missingNodes: [] });
  assert.equal(h.children.length, 0);
  assert.equal(harness({ configuration: { enabled: false } }).runtime.capability().available, false);
  assert.equal(harness({ configuration: { modelPath: path.resolve("model.gguf") } }).runtime.capability().available, false);
  assert.equal(harness({ overrides: { fileExists: () => false } }).runtime.capability().available, false);
  assert.equal(harness({ configuration: { installDir: "relative" } }).runtime.capability().available, false);
});

test("successful caption uses private native argv, authenticates identity and waits for close", async () => {
  const h = harness();
  const operation = h.runtime.caption(input);
  assert.equal(h.runtime.isBusy(), true);
  const result = await operation;
  assert.equal(result.prompt, "A red square.");
  assert.equal(result.engine, "kvmem");
  assert.equal(result.released, true);
  assert.equal(result.modelName, "private-model.ninfer");
  assert.equal(h.children[0].closed, true);
  assert.equal(h.runtime.isBusy(), false);
  assert.deepEqual(h.requests.map((request) => request.route), ["/health", "/v1/models", "/props", "/v1/chat/completions"]);
  const child = h.children[0];
  assert.equal(child.options.shell, false);
  assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.stdio, "ignore");
  assert.equal(child.options.cwd, path.join(config.installDir, "workers", "ninfer"));
  assert.equal(child.options.env.CUDA_VISIBLE_DEVICES, "GPU-selected");
  assert.equal(child.argv[0], config.modelPath);
  const arg = (name) => child.argv[child.argv.indexOf(name) + 1];
  assert.equal(arg("--spec"), "none");
  assert.equal(arg("--kvmem-budget"), "2048");
  assert.equal(arg("--kvmem-gen-reserve"), "512");
  assert.equal(arg("--kvmem-host-mib"), "1024");
  assert.equal(arg("--max-context"), "8192");
  assert.equal(arg("--vision-max-merged"), "1024");
  assert.ok(child.argv.includes("--vision-cpu"));
  assert.ok(child.argv.includes("--no-thinking"));
  assert.ok(child.argv.includes("--no-cuda-graph"));
  assert.equal(child.argv.includes("--model-suspend"), false);
  assert.equal(child.argv.includes("--kvmem-disk-path"), false);
  const body = JSON.parse(h.requests.at(-1).options.body);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.messages[1].content[1].image_url.url, image);
  assert.equal(h.logs.length, 0);
  await h.runtime.close();
});

test("GPU vision uses resident flags while text stays on CUDA and cleanup remains confirmed", async () => {
  const h = harness({ configuration: { visionMode: "gpu" } });
  const result = await h.runtime.caption({ ...input, hardware: { modelBytes: 12 * 1024 ** 3, availableVramBytes: 16 * 1024 ** 3 } });
  const args = h.children[0].argv;
  assert.equal(args.includes("--vision-cpu"), false);
  assert.equal(args[args.indexOf("--vision-residency") + 1], "resident");
  assert.equal(args[args.indexOf("--device") + 1], "0");
  assert.equal(result.visionMode, "gpu");
  assert.equal(result.visionRequested, "gpu");
  assert.equal(result.released, true);
  assert.equal(h.children[0].closed, true);
});

test("auto selects CPU under pressure; explicit GPU refuses before spawning", async () => {
  const hardware = { modelBytes: 12 * 1024 ** 3, availableVramBytes: 14 * 1024 ** 3 };
  const auto = harness({ configuration: { visionMode: "auto" } });
  const result = await auto.runtime.caption({ ...input, hardware });
  assert.equal(result.visionMode, "cpu");
  assert.equal(result.visionSelectionReason, "cpu-preserve-vram");
  assert.ok(auto.children[0].argv.includes("--vision-cpu"));
  const gpu = harness({ configuration: { visionMode: "gpu" } });
  await assert.rejects(gpu.runtime.caption({ ...input, hardware }), { code: "kvmem_insufficient_vram" });
  assert.equal(gpu.children.length, 0);
  assert.equal(gpu.runtime.isBusy(), false);
  await assert.rejects(gpu.runtime.caption(input), { code: "kvmem_insufficient_vram" });
});

test("GPU failure is not silently retried as CPU", async () => {
  const h = harness({ configuration: { visionMode: "gpu" }, fetchRoute: ({ route }) => route === "/v1/chat/completions" ? json({}, 500) : undefined });
  await assert.rejects(h.runtime.caption({ ...input, hardware: { modelBytes: 12 * 1024 ** 3, availableVramBytes: 16 * 1024 ** 3 } }), { code: "kvmem_http_error" });
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].closed, true);
  assert.equal(h.runtime.isBusy(), false);
});

test("a second finished caption starts a new child and new model/key identities", async () => {
  const h = harness();
  await h.runtime.caption(input); await h.runtime.caption(input);
  assert.equal(h.children.length, 2);
  for (const flag of ["--model-id", "--api-key"]) {
    const values = h.children.map((child) => child.argv[child.argv.indexOf(flag) + 1]);
    assert.notEqual(values[0], values[1]);
  }
});

test("invalid image or already-aborted request never starts inference", async () => {
  const h = harness();
  await assert.rejects(h.runtime.caption({ ...input, imageDataUrl: "https://example.com/private.png" }), { code: "kvmem_invalid_image" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.runtime.caption({ ...input, signal: controller.signal }), { code: "kvmem_cancelled" });
  assert.equal(h.children.length, 0); assert.equal(h.runtime.isBusy(), false);
});

test("cancellation during silent startup closes only the owned worker", async () => {
  const controller = new AbortController();
  const h = harness({ fetchRoute: () => new Promise(() => {}) });
  const result = h.runtime.caption({ ...input, signal: controller.signal });
  const rejection = assert.rejects(result, { code: "kvmem_cancelled" });
  await waitFor(() => h.requests.length > 0); controller.abort();
  await rejection;
  assert.equal(h.children[0].closed, true); assert.equal(h.runtime.isBusy(), false);
});

test("cancellation aborts the upstream HTTP request, including non-streaming generation", async () => {
  const controller = new AbortController();
  const h = harness({ fetchRoute: ({ route }) => route === "/v1/chat/completions" ? new Promise(() => {}) : undefined });
  const result = h.runtime.caption({ ...input, signal: controller.signal });
  const rejection = assert.rejects(result, { code: "kvmem_cancelled" });
  await waitFor(() => h.requests.some((request) => request.route === "/v1/chat/completions"));
  const signal = h.requests.at(-1).options.signal;
  controller.abort(); await rejection;
  assert.equal(signal.aborted, true); assert.equal(h.children[0].closed, true);
});

test("synchronous and asynchronous spawn failures are sanitized and release ownership", async () => {
  for (const setup of [{ spawnError: true }, { spawnEventError: true, fetchRoute: () => new Promise(() => {}) }]) {
    const h = harness(setup);
    await assert.rejects(h.runtime.caption(input), (error) => error.code === "kvmem_spawn_failed" && !error.message.includes("raw"));
    assert.equal(h.runtime.isBusy(), false);
    if (h.children.length) assert.equal(h.children[0].closed, true);
  }
});

test("pre-existing service authentication or model mismatch never causes generation or external termination", async () => {
  for (const mode of ["auth", "model"]) {
    const external = { kills: 0 };
    const h = harness({ fetchRoute: ({ route }) => {
      if (mode === "auth" && route === "/health") return json({}, 401);
      if (mode === "model" && route === "/v1/models") return json({ data: [{ id: "user-existing-worker" }] });
      return undefined;
    } });
    await assert.rejects(h.runtime.caption(input), { code: "kvmem_identity_mismatch" });
    assert.equal(h.requests.some((request) => request.route === "/v1/chat/completions"), false);
    assert.equal(h.children[0].closed, true);
    assert.equal(external.kills, 0);
  }
});

test("port allocation failure does not spawn or attempt to stop a port owner", async () => {
  const h = harness({ overrides: { freePort: async () => { throw Error("port occupied"); } } });
  await assert.rejects(h.runtime.caption(input));
  assert.equal(h.children.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.runtime.isBusy(), false);
});

test("props is fail-closed for wrong backend, unknown vision and false vision objects", async () => {
  for (const props of [{ backend: "other", modalities: { vision: true } }, { backend: "ninfer" },
    { backend: "ninfer", kvmem: { vision: { enabled: false } } }, { backend: "ninfer", modalities: { vision: false }, kvmem: { vision: true } }]) {
    const h = harness({ fetchRoute: ({ route }) => route === "/props" ? json(props) : undefined });
    await assert.rejects(h.runtime.caption(input), { code: "kvmem_capability_mismatch" });
    assert.equal(h.children[0].closed, true);
  }
  const h = harness({ fetchRoute: ({ route }) => route === "/props" ? json({ backend: "ninfer", kvmem: { vision: { enabled: true } } }) : undefined });
  assert.equal((await h.runtime.caption(input)).released, true);
});

test("startup timeout and request timeout are bounded even if fetch ignores abort", async () => {
  const startup = harness({ configuration: { startupTimeoutMs: 12 }, fetchRoute: () => new Promise(() => {}) });
  await assert.rejects(startup.runtime.caption(input), { code: "kvmem_startup_timeout" });
  assert.equal(startup.children[0].closed, true);
  const request = harness({ configuration: { requestTimeoutMs: 12 }, fetchRoute: ({ route }) => route === "/v1/chat/completions" ? new Promise(() => {}) : undefined });
  await assert.rejects(request.runtime.caption(input), { code: "kvmem_request_timeout" });
  assert.equal(request.children[0].closed, true);
});

test("per-caption local timeout overrides an older desktop request timeout without changing startup or cleanup", async (t) => {
  const realTimer = globalThis.setTimeout;
  const deadlines = [];
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    deadlines.push(ms);
    return realTimer(callback, ms === 900000 ? 1000 : ms, ...args);
  });
  const h = harness({ configuration: { requestTimeoutMs: 12 }, fetchRoute: async ({ route }) => {
    if (route === "/v1/chat/completions") await new Promise(resolve => realTimer(resolve, 30));
    return undefined;
  } });
  const result = await h.runtime.caption({ ...input, timeoutSeconds: 900 });
  assert.equal(result.released, true);
  assert.ok(deadlines.includes(900000));
  assert.equal(h.requests.at(-1).options.timeoutMs, 900000);
  assert.equal(h.children[0].closed, true);
});

test("invalid per-caption local timeouts are rejected before spawning", async () => {
  for (const timeoutSeconds of [29, 1801, 'bad', 30.5]) {
    const h = harness();
    await assert.rejects(h.runtime.caption({ ...input, timeoutSeconds }), { code: 'local_invalid_timeout' });
    assert.equal(h.children.length, 0);
    assert.equal(h.runtime.isBusy(), false);
  }
});

test("configured long local deadline still aborts HTTP and waits for worker exit", async (t) => {
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => realTimer(callback, ms === 30000 ? 15 : ms, ...args));
  const h = harness({ fetchRoute: ({route}) => route === '/v1/chat/completions' ? new Promise(()=>{}) : undefined });
  await assert.rejects(h.runtime.caption({ ...input, timeoutSeconds: 30 }), { code: 'kvmem_request_timeout' });
  assert.equal(h.children[0].closed, true);
  assert.equal(h.runtime.isBusy(), false);
});

test("concurrent caption is rejected; close aborts and awaits active cleanup, then stays closed", async () => {
  const h = harness({ fetchRoute: () => new Promise(() => {}) });
  const result = h.runtime.caption(input);
  const rejection = assert.rejects(result, { code: "kvmem_cancelled" });
  await assert.rejects(h.runtime.caption(input), { code: "kvmem_busy" });
  await waitFor(() => h.children.length > 0);
  await h.runtime.close(); await rejection; await h.runtime.close();
  assert.equal(h.children.length, 1); assert.equal(h.children[0].closed, true); assert.equal(h.runtime.isBusy(), false);
  await assert.rejects(h.runtime.caption(input), { code: "kvmem_closed" });
});

test("HTTP errors, malformed JSON, wrong response identity and empty output always clean up without raw logs", async () => {
  for (const [response, code] of [
    [() => json({ secret: input.userPrompt }, 500), "kvmem_http_error"],
    [() => new Response(input.userPrompt), "kvmem_bad_response"],
    [() => json({ model: "other" }), "kvmem_identity_mismatch"],
    [({ id }) => json({ model: id, choices: [{ message: { content: " " }, finish_reason: "stop" }] }), "kvmem_empty_output"],
  ]) {
    const h = harness({ fetchRoute: (context) => context.route === "/v1/chat/completions" ? response(context) : undefined });
    await assert.rejects(h.runtime.caption(input), (error) => error.code === code && !error.message.includes(input.userPrompt));
    assert.equal(h.children[0].closed, true); assert.equal(h.runtime.isBusy(), false); assert.equal(h.logs.length, 0);
  }
});

test("process exit during request fails promptly and never signals an already-closed process", async () => {
  const h = harness({ fetchRoute: ({ route, children }) => {
    if (route === "/v1/chat/completions") { setImmediate(() => children[0].finish(2)); return new Promise(() => {}); }
    return undefined;
  } });
  await assert.rejects(h.runtime.caption(input), { code: "kvmem_worker_exited" });
  assert.deepEqual(h.children[0].kills, []); assert.equal(h.runtime.isBusy(), false);
});

test("unconfirmed exit overrides success, keeps busy lock, and close can retry owned cleanup", async () => {
  const h = harness({ closes: false });
  await assert.rejects(h.runtime.caption(input), { code: "kvmem_release_failed" });
  assert.equal(h.runtime.isBusy(), true);
  assert.deepEqual(h.children[0].kills, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(h.runtime.caption(input), { code: "kvmem_busy" });
  assert.deepEqual(h.logs, [["KVMem worker exit was not confirmed"]]);
  h.children[0].closes = true;
  await h.runtime.close();
  assert.equal(h.runtime.isBusy(), false); assert.equal(h.children[0].closed, true);
});

test("a late close clears retained ownership after earlier cleanup failure", async () => {
  const h = harness({ closes: false });
  await assert.rejects(h.runtime.caption(input), { code: "kvmem_release_failed" });
  h.children[0].finish();
  assert.equal(h.runtime.isBusy(), false);
});

test("cancellation while successful output waits for worker close cannot publish success", async () => {
  const controller = new AbortController();
  const h = harness({ closes: false, overrides: { stopTimeoutMs: 200 } });
  const operation = h.runtime.caption({ ...input, signal: controller.signal });
  const rejected = assert.rejects(operation, { code: "kvmem_cancelled" });
  await waitFor(() => h.children[0]?.kills.length > 0);
  assert.equal(h.runtime.isBusy(), true);
  controller.abort(); h.children[0].finish();
  await rejected;
  assert.equal(h.runtime.isBusy(), false);
});

test("length finish is surfaced as truncated rather than claiming a complete description", async () => {
  const h = harness({ fetchRoute: ({ route, id }) => route === "/v1/chat/completions" ? json({ model: id,
    choices: [{ message: { content: "partial" }, finish_reason: "length" }] }) : undefined });
  const result = await h.runtime.caption(input);
  assert.equal(result.truncated, true); assert.equal(result.released, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createPromptOptimizer } from "../src/prompt-optimizer.js";
import { requestAgentCloudJson, registerAgentCloudRoutes } from "../src/agent-cloud.js";
import { normalizePromptCloudTimeoutSeconds } from "../src/prompt-cloud-timeout.js";

const cloud = { baseUrl: "http://127.0.0.1:12345", apiKey: "local-test-key", model: "test-model" };
const success = { choices: [{ message: { content: "A red cube on a table." } }] };
const nativeSuccess = { content: [{ type: "text", text: "A red cube on a table." }], stop_reason: "end_turn" };
const response = (data = success, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(data) });
const optimizer = (cloudFetch) => createPromptOptimizer({ config: { rootDir: "." }, comfy: null, cloudFetch });
const optimize = (instance, options = {}) => instance.optimizeImage({ prompt: "red cube", engine: "cloud", cloud, ...options });
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A deterministic clock, including socket timers set by the native request mock.
// No test waits for the public 30-second minimum or calls a real cloud provider.
function clock(t) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const scheduled = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, callback });
    scheduled.push(delay);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  return {
    scheduled,
    timers,
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].callback();
      }
      now = end;
      await flush();
    },
  };
}

function nativeRequest(t, { headerDelay = 0, bodyDelay = 0, reply = nativeSuccess, status = 200 } = {}) {
  const calls = [];
  t.mock.method(http, "request", (url, options, callback) => {
    const req = new EventEmitter();
    const call = { url: String(url), options, req, destroyed: false };
    calls.push(call);
    let socketTimer;
    let headerTimer;
    let bodyTimer;
    let upstream;
    const aborted = () => req.destroy(options.signal.reason);
    req.setTimeout = (ms, onTimeout) => {
      call.socketTimeoutMs = ms;
      socketTimer = setTimeout(onTimeout, ms);
      return req;
    };
    req.destroy = () => {
      if (call.destroyed) return;
      call.destroyed = true;
      for (const timer of [socketTimer, headerTimer, bodyTimer]) clearTimeout(timer);
      options.signal.removeEventListener("abort", aborted);
      upstream?.destroy();
      req.emit("close");
    };
    req.end = (payload) => {
      call.payload = JSON.parse(payload);
      headerTimer = setTimeout(() => {
        upstream = new PassThrough();
        upstream.statusCode = status;
        upstream.headers = { "content-type": "application/json" };
        upstream.complete = false;
        callback(upstream);
        bodyTimer = setTimeout(() => {
          upstream.complete = true;
          upstream.end(JSON.stringify(reply));
          clearTimeout(socketTimer);
        }, bodyDelay);
      }, headerDelay);
    };
    options.signal.addEventListener("abort", aborted, { once: true });
    return req;
  });
  return calls;
}

test("timeout validation defaults missing values to 600 and accepts only integer seconds in range", () => {
  for (const value of [undefined, null, ""]) assert.equal(normalizePromptCloudTimeoutSeconds(value), 600);
  for (const value of [30, "30", 600, "600", 1800, "1800", " 900 "]) assert.equal(normalizePromptCloudTimeoutSeconds(value), Number(value));
  for (const value of [0, 29, 1801, -1, 30.5, NaN, Infinity, true, false, [], [600], {}, " ", "600s", "30.1", "6e2", "0x258", "Infinity", "null"]) {
    assert.throws(() => normalizePromptCloudTimeoutSeconds(value), { status: 400, code: "cloud_invalid_timeout" }, String(value));
  }
});

for (const timeoutSeconds of [undefined, "900", 1800]) test(`OpenAI passes ${timeoutSeconds ?? "default 600"} seconds to request options without changing inference payload`, async (t) => {
  const time = clock(t);
  let sent;
  const instance = optimizer(async (_url, options) => { sent = options; return response(); });
  const result = await optimize(instance, { cloud: { ...cloud, timeoutSeconds } });
  assert.match(result.prompt, /red cube/);
  const ms = (timeoutSeconds === undefined ? 600 : Number(timeoutSeconds)) * 1000;
  assert.equal(sent.timeoutMs, ms);
  assert.deepEqual(time.scheduled, [ms]);
  assert.equal(time.timers.size, 0);
  assert.deepEqual(Object.keys(JSON.parse(sent.body)).sort(), ["max_tokens", "messages", "model", "temperature"]);
});

for (const phase of ["headers", "body"]) test(`OpenAI ${phase} deadline handles a fetch stub ignoring signal`, async (t) => {
  const time = clock(t);
  let sentSignal;
  let count = 0;
  const instance = optimizer(async (_url, { signal }) => {
    sentSignal = signal;
    count++;
    if (phase === "headers") return new Promise(() => {});
    return { ...response(), text: () => new Promise(() => {}) };
  });
  const pending = assert.rejects(optimize(instance, { cloud: { ...cloud, timeoutSeconds: 30 } }), { status: 504, code: "cloud_api_timeout" });
  await time.tick(30000);
  await pending;
  assert.equal(sentSignal.aborted, true);
  assert.equal(count, 1);
  assert.equal(time.timers.size, 0);
});

for (const phase of ["headers", "body"]) test(`OpenAI ${phase} cancellation is 499, not timeout or 502`, async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const instance = optimizer(async () => phase === "headers" ? new Promise(() => {}) : { ...response(), text: () => new Promise(() => {}) });
  const pending = assert.rejects(optimize(instance, { signal: controller.signal }), { status: 499, code: "cloud_api_cancelled" });
  await flush();
  controller.abort(new Error("User stopped"));
  await pending;
  assert.equal(time.timers.size, 0);
});

test("pre-aborted request never invokes fetch and generic AbortError is not a 502", async () => {
  const controller = new AbortController();
  controller.abort();
  let count = 0;
  const instance = optimizer(async () => { count++; throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(optimize(instance, { signal: controller.signal }), { status: 499, code: "cloud_api_cancelled" });
  assert.equal(count, 0);
  await assert.rejects(optimize(instance), { status: 499, code: "cloud_api_cancelled" });
});

test("temperature retry shares remaining deadline rather than restarting the clock", async (t) => {
  const time = clock(t);
  const temperatures = [];
  const instance = optimizer((_url, options) => {
    temperatures.push(JSON.parse(options.body).temperature);
    return new Promise((resolve) => setTimeout(() => resolve(temperatures.length === 1
      ? response({ error: { message: "invalid temperature: only 1 is allowed" } }, 400) : response()), 20000));
  });
  const pending = assert.rejects(optimize(instance, { cloud: { ...cloud, timeoutSeconds: 30 } }), { status: 504, code: "cloud_api_timeout" });
  await time.tick(20000);
  assert.deepEqual(temperatures, [0.6, 1]);
  await time.tick(10000);
  await pending;
  await time.tick(10000); // Observe the late result without another retry or leak.
  assert.deepEqual(temperatures, [0.6, 1]);
});

test("temperature compatibility retry succeeds once and never becomes a generic retry policy", async () => {
  const bodies = [];
  const instance = optimizer(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return bodies.length === 1 ? response({ error: { message: "temperature not supported" } }, 400) : response();
  });
  assert.match((await optimize(instance)).prompt, /red cube/);
  assert.deepEqual(bodies.map(({ temperature }) => temperature), [0.6, 1]);
  assert.deepEqual({ ...bodies[0], temperature: 1 }, bodies[1]);
  let count = 0;
  const failure = optimizer(async () => { count++; return response({ error: { message: "only 1 is allowed" } }, 400); });
  await assert.rejects(optimize(failure), { status: 502, code: "cloud_api_failed" });
  assert.equal(count, 2);
});

test("OpenAI native request exceeds bundled fetch's 300s ceiling with configured socket allowance", async (t) => {
  const time = clock(t);
  const calls = nativeRequest(t, { headerDelay: 310000, bodyDelay: 310000, reply: success });
  const pending = optimize(optimizer(), { cloud: { ...cloud, timeoutSeconds: 900 } });
  await time.tick(620000);
  assert.match((await pending).prompt, /red cube/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].socketTimeoutMs, 900000);
  assert.equal(calls[0].options.agent, false);
  assert.equal(calls[0].options.signal.aborted, false);
});

for (const apiFormat of ["openai", "anthropic"]) {
  for (const phase of ["headers", "body"]) test(`${apiFormat} native ${phase} total deadline destroys one request`, async (t) => {
    const time = clock(t);
    const calls = nativeRequest(t, { headerDelay: phase === "headers" ? 60000 : 0, bodyDelay: 60000, reply: apiFormat === "openai" ? success : nativeSuccess });
    const pending = assert.rejects(optimize(optimizer(), { cloud: { ...cloud, apiFormat, timeoutSeconds: 30 } }), { status: 504, code: "cloud_api_timeout" });
    await time.tick(30000);
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].socketTimeoutMs, 30000);
    assert.equal(calls[0].destroyed, true);
  });
  test(`${apiFormat} native user cancellation is distinct from deadline`, async (t) => {
    clock(t);
    const calls = nativeRequest(t, { headerDelay: 100000 });
    const controller = new AbortController();
    const pending = assert.rejects(optimize(optimizer(), { cloud: { ...cloud, apiFormat }, signal: controller.signal }), { status: 499, code: "cloud_api_cancelled" });
    await flush();
    controller.abort();
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].destroyed, true);
  });
}

for (const timeoutSeconds of [undefined, "900"]) test(`non-OpenAI ${timeoutSeconds ?? "default"} extends native headers and idle limits beyond 15s/30s`, async (t) => {
  const time = clock(t);
  const calls = nativeRequest(t, { headerDelay: 45000, bodyDelay: 90000 });
  const pending = optimize(optimizer(), { cloud: { ...cloud, apiFormat: "anthropic", timeoutSeconds } });
  await time.tick(135000);
  assert.match((await pending).prompt, /red cube/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].socketTimeoutMs, Number(timeoutSeconds ?? 600) * 1000);
  assert.equal(calls[0].payload.stream, false);
  assert.equal(time.scheduled.includes(15000), false);
  assert.equal(time.scheduled.includes(30000), false);
});

test("internal Agent timeout override is not read from payload and defaults remain 120s/15s/30s", async (t) => {
  const time = clock(t);
  const calls = nativeRequest(t, { headerDelay: 20000 });
  const pending = assert.rejects(requestAgentCloudJson({ ...cloud, timeoutMs: 900000, request: {
    model: cloud.model, messages: [{ role: "user", content: "test" }],
  } }), { code: "upstream_timeout", status: 504 });
  await time.tick(15000);
  await pending;
  assert.equal(calls[0].socketTimeoutMs, 30000);
  assert.ok(time.scheduled.includes(120000));
  assert.ok(time.scheduled.includes(15000));
});

test("registerAgentCloudRoutes still uses original default transport deadlines", async (t) => {
  const time = clock(t);
  const calls = nativeRequest(t, { headerDelay: 20000 });
  const routes = new Map();
  registerAgentCloudRoutes({ use() {}, post(path, handler) { routes.set(path, handler); } });
  const req = new EventEmitter();
  Object.assign(req, { socket: { remoteAddress: "127.0.0.1", localPort: 8190 }, headers: { host: "127.0.0.1:8190" }, is: () => true,
    body: { ...cloud, timeoutMs: 900000, request: { model: cloud.model, messages: [{ role: "user", content: "test" }] } } });
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (data) => { res.result = data; };
  const pending = routes.get("/api/agent/cloud/chat")(req, res);
  await time.tick(15000);
  await pending;
  assert.equal(res.statusCode, 504);
  assert.equal(res.result.error.code, "upstream_timeout");
  assert.equal(calls[0].socketTimeoutMs, 30000);
  assert.ok(time.scheduled.includes(120000));
});

for (const apiFormat of ["openai", "anthropic"]) test(`${apiFormat} actual local upstream disconnect is bounded and never resubmits inference`, { timeout: 3000 }, async (t) => {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"partial":');
    setImmediate(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  await assert.rejects(optimize(optimizer(), { cloud: { ...cloud, apiFormat, baseUrl: `http://127.0.0.1:${server.address().port}` } }), { status: 502 });
  assert.equal(count, 1);
});

test("OpenAI native redirect fails clearly without following it or waiting for its body", async (t) => {
  const time = clock(t);
  const calls = nativeRequest(t, { status: 307, bodyDelay: 900000 });
  const pending = assert.rejects(optimize(optimizer()), (error) => {
    assert.equal(error.code, "cloud_api_failed");
    assert.match(error.message, /最终 API 地址/);
    return true;
  });
  await time.tick(0);
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].destroyed, true);
});

test("invalid timeout is rejected before either transport submits work", async () => {
  for (const apiFormat of ["openai", "anthropic"]) await assert.rejects(optimize(optimizer(() => assert.fail("must not send")), {
    cloud: { ...cloud, apiFormat, timeoutSeconds: "nonsense" },
  }), { status: 400, code: "cloud_invalid_timeout" });
});

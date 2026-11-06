import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { createGatewayApp, stopGateway } from "../src/server.js";

import { assertAgentCloudCaller, createAgentCloudTransport, isPublicAgentCloudAddress,
  normalizeAgentCloudEndpoint, registerAgentCloudRoutes, resolveAgentCloudTarget, resolveAgentCloudTargets } from "../src/agent-cloud.js";

const API_KEY = "not-a-real-secret-123456";
const ORIGIN = "http://127.0.0.1:3000";
const CONFIG = { host: "127.0.0.1", port: 8190, publicBaseUrl: "http://127.0.0.1:8190", corsOrigins: [ORIGIN, "http://localhost:3000"] };

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t, handler, transportOptions = {}, config = CONFIG) {
  const upstream = await serve(t, handler);
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  registerAgentCloudRoutes(app, { config, transport: createAgentCloudTransport(transportOptions) });
  const gateway = await serve(t, app);
  const post = (operation, extra = {}, headers = {}) => fetch(`${gateway.url}/api/agent/cloud/${operation}`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify({ baseUrl: upstream.url, apiKey: API_KEY, ...(operation === "chat" ? { request: {
      model: "test-model", messages: [{ role: "user", content: "hello" }], stream: true,
    } } : {}), ...extra }),
  });
  return { upstream, gateway, post };
}

async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : null;
}
const json = (res, status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

// All requests in this suite stay on local stub servers; cloud DNS/HTTPS are injected.
test("normalizes root, custom/version bases and full chat/model endpoints", () => {
  for (const [input, expected] of [
    ["https://api.example", "https://api.example/v1/chat/completions"],
    ["https://api.example/v1/", "https://api.example/v1/chat/completions"],
    ["https://api.example/custom/openai", "https://api.example/custom/openai/chat/completions"],
    ["https://api.example/v2/chat/completions", "https://api.example/v2/chat/completions"],
    ["http://127.0.0.1:18800", "http://127.0.0.1:18800/v1/chat/completions"],
    ["http://[::1]:18800/v1", "http://[::1]:18800/v1/chat/completions"],
  ]) assert.equal(normalizeAgentCloudEndpoint(input).href, expected);
  assert.equal(normalizeAgentCloudEndpoint("https://api.example/custom/chat/completions", "models").pathname, "/custom/models");
  assert.equal(normalizeAgentCloudEndpoint("https://api.example/v1/models", "models").pathname, "/v1/models");
});

test("rejects unsafe URLs before network access", () => {
  for (const url of ["//example.com/v1", "file:///tmp/model", "http://api.example", "https://user:pass@api.example",
    "https://@api.example", "https://api.example/v1?key=secret", "https://api.example/#fragment",
    "https://api.example//chat", "https://api.example/a%2fb", "https://api.example/a\\b", "https://api.example./v1",
    "https://10.0.0.1", "https://192.168.1.2", "https://169.254.169.254", "https://0.0.0.0", "https://[::]",
    "https://[::ffff:127.0.0.1]", "https://[fd00::1]", "https://[fe80::1]", "http://127.1", "http://2130706433",
    "http://0x7f000001", "https://[2002:7f00:1::1]", "https://[2001:db8::1]"]) {
    assert.throws(() => normalizeAgentCloudEndpoint(url), undefined, url);
  }
});

test("public address guard excludes private, mapped, transition and reserved ranges", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicAgentCloudAddress(ip), true, ip);
  for (const ip of ["0.1.2.3", "100.64.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1", "198.18.1.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::ffff:8.8.8.8", "64:ff9b::7f00:1",
    "2001::1", "2001:20::1", "2002:0808:0808::1", "3fff::1", "fc00::1", "fe80::1", "ff02::1", "localhost"]) {
    assert.equal(isPublicAgentCloudAddress(ip), false, ip);
  }
});

test("DNS accepts public answers only, rejects mixed/private answers including localhost", async () => {
  const url = normalizeAgentCloudEndpoint("https://models.example/v1");
  for (const addresses of [[{ address: "10.1.2.3" }], [{ address: "8.8.8.8" }, { address: "::ffff:127.0.0.1" }], [], [{ address: "garbage" }]]) {
    await assert.rejects(resolveAgentCloudTarget(url, async () => addresses), { code: "private_address" });
  }
  await assert.rejects(resolveAgentCloudTarget(normalizeAgentCloudEndpoint("https://localhost"), async () => [{ address: "127.0.0.1" }]), { code: "private_address" });
  assert.deepEqual(await resolveAgentCloudTarget(url, async () => [{ address: "8.8.8.8", family: 4 }]), { address: "8.8.8.8", family: 4 });
  await assert.rejects(resolveAgentCloudTarget(url, async () => { throw new Error(API_KEY); }), { code: "dns_failed" });
});

test("caller guard requires loopback peer/Host and exact configured local Origin", () => {
  const request = (headers = {}, remoteAddress = "127.0.0.1") => ({ socket: { remoteAddress, localPort: 8190 }, headers: { host: "127.0.0.1:8190", origin: ORIGIN, ...headers } });
  assert.doesNotThrow(() => assertAgentCloudCaller(request(), CONFIG));
  assert.doesNotThrow(() => assertAgentCloudCaller(request({ origin: undefined }), CONFIG));
  assert.doesNotThrow(() => assertAgentCloudCaller(request({ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }), CONFIG));
  assert.doesNotThrow(() => assertAgentCloudCaller(request({ origin: "http://127.0.0.1:8190" }, "::ffff:127.0.0.1"), CONFIG));
  for (const req of [request({}, "10.0.0.1"), request({ host: "evil.example:8190" }), request({ origin: "https://evil.example" }),
    request({ origin: "http://127.0.0.1:9999" }), request({ origin: "null" }), request({ origin: "file://" }),
    request({ origin: undefined, "sec-fetch-site": "cross-site" }), request({ host: "127.0.0.1:8190@evil.example" })]) {
    assert.throws(() => assertAgentCloudCaller(req, { ...CONFIG, corsOrigins: [...CONFIG.corsOrigins, "*", "https://evil.example"] }));
  }
});

test("models performs only GET /models, forwards no client credentials except explicit key", async (t) => {
  let calls = 0;
  const { post } = await fixture(t, async (req, res) => {
    calls += 1;
    assert.equal(req.url, "/v1/models");
    assert.equal(req.method, "GET");
    assert.equal(await body(req), null);
    assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["x-gateway-token"], undefined);
    assert.equal(req.headers.origin, undefined);
    json(res, 200, { data: [{ id: "test-model", apiKey: API_KEY, object: "model" }], private: API_KEY });
  });
  const response = await post("models", {}, { cookie: "no-forward", "x-gateway-token": "no-forward", authorization: "Bearer wrong-key" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { object: "list", data: [{ id: "test-model", object: "model" }] });
  assert.equal(calls, 1);
});

test("chat forwards only allowed payload fields, preserving messages and tool calls", async (t) => {
  const request = { model: "test-model", messages: [{ role: "user", content: "hello" }, { role: "tool", tool_call_id: "a", content: "ok" }],
    tools: [{ type: "function", function: { name: "canvas_get_state", parameters: { type: "object" } } }],
    tool_choice: "auto", stream: false, temperature: 0.4, unexpected: API_KEY };
  const { post } = await fixture(t, async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.method, "POST");
    const sent = await body(req);
    const { unexpected, ...expected } = request;
    assert.deepEqual(sent, expected);
    res.setHeader("set-cookie", "must-not-forward=1");
    res.setHeader("x-provider-secret", API_KEY);
    json(res, 200, { choices: [{ message: { content: "ok", tool_calls: [{ id: "a", function: { name: "canvas_get_state", arguments: "{}" } }] } }] });
  });
  const response = await post("chat", { request });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-provider-secret"), null);
  assert.equal((await response.json()).choices[0].message.tool_calls[0].id, "a");
});

test("loopback local model may omit API key", async (t) => {
  const { post } = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    json(res, 200, { data: [] });
  });
  assert.equal((await post("models", { apiKey: "" })).status, 200);
});

test("upstream status and redirects never return or follow secret-bearing errors", async (t) => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 429, 500]) {
    await t.test(`HTTP ${status}`, async (t) => {
      let calls = 0;
      const { post } = await fixture(t, (_req, res) => {
        calls += 1;
        res.setHeader("location", `http://127.0.0.1:1/?key=${API_KEY}`);
        json(res, status, { error: { message: `Authorization: Bearer ${API_KEY}` } });
      });
      const response = await post("chat");
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.equal(text.includes(API_KEY), false);
      assert.equal(text.includes("127.0.0.1"), false);
      assert.equal(calls, 1);
    });
  }
});

test("provider JSON echo and SSE error bodies cannot leak request key", async (t) => {
  await t.test("successful JSON", async (t) => {
    const { post } = await fixture(t, (_req, res) => json(res, 200, { choices: [{ message: { content: `Echo ${API_KEY} Bearer some-other-secret` } }], apiKey: API_KEY }));
    const text = await (await post("chat")).text();
    assert.equal(text.includes(API_KEY), false);
    assert.equal(text.includes("some-other-secret"), false);
    assert.match(text, /redacted/);
  });
  await t.test("SSE after headers", async (t) => {
    const { post } = await fixture(t, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end(`data: ${JSON.stringify({ error: { message: API_KEY } })}\n\n`);
    });
    const text = await (await post("chat")).text();
    assert.match(text, /upstream_status/);
    assert.equal(text.includes(API_KEY), false);
  });
});

test("SSE is incremental, keeps split UTF-8/tool arguments, omits comments and sanitizes strings", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const { post } = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`: ${API_KEY}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
    await gate;
    const event = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: `中文 ${API_KEY}`, tool_calls: [{ index: 0, id: "call1", function: { name: "canvas_get_state", arguments: "{" } }] } }] })}\r\n\r\n`);
    const split = event.indexOf(Buffer.from("中文")) + 1;
    res.write(event.subarray(0, split));
    res.write(event.subarray(split));
    res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\ndata: [DONE]\n\n');
  });
  const response = await post("chat");
  const reader = response.body.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /first/);
  release();
  for (;;) { const item = await reader.read(); if (item.done) break; text += new TextDecoder().decode(item.value); }
  assert.match(text, /中文/);
  assert.match(text, /call1/);
  assert.match(text, /\[DONE\]/);
  assert.equal(text.includes(API_KEY), false);
  assert.equal(/^:/m.test(text), false);
});

test("bad content types, invalid JSON/events and response budgets fail safely", async (t) => {
  for (const [name, handler, options] of [
    ["HTML", (_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(API_KEY); }, {}],
    ["JSON", (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(API_KEY); }, {}],
    ["event", (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${API_KEY}\n\n`); }, {}],
    ["response limit", (_req, res) => json(res, 200, { choices: [{ message: { content: "x".repeat(1000) } }] }), { maxResponseBytes: 100 }],
    ["event limit", (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${"x".repeat(1000)}`); }, { maxEventBytes: 100 }],
  ]) await t.test(name, async (t) => {
    const { post } = await fixture(t, handler, options);
    const response = await post("chat");
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.equal(text.includes(API_KEY), false);
    assert.ok(JSON.parse(text).error);
  });
});

test("header deadline aborts upstream and returns no unsafe exception", async (t) => {
  const { post } = await fixture(t, () => {}, { headerTimeoutMs: 50, timeoutMs: 500 });
  const response = await post("chat");
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "upstream_timeout");
});

test("client disconnect cancels upstream stream", { timeout: 3000 }, async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  const { gateway, upstream } = await fixture(t, (_req, res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
  });
  const controller = new AbortController();
  const response = await fetch(`${gateway.url}/api/agent/cloud/chat`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: upstream.url, apiKey: API_KEY, request: { model: "m", messages: [{ role: "user", content: "x" }], stream: true } }), signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await upstreamClosed;
});

test("public DNS is resolved once and pinned for HTTPS request with original SNI/hostname", async (t) => {
  const local = await serve(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    json(res, 200, { data: [] });
  });
  let lookups = 0;
  let requests = 0;
  const app = express();
  app.use(express.json());
  registerAgentCloudRoutes(app, { config: CONFIG, transport: createAgentCloudTransport({
    lookup: async (host) => { lookups += 1; assert.equal(host, "model.example"); return [{ address: "8.8.8.8", family: 4 }]; },
    httpsRequest: (url, options, callback) => {
      requests += 1;
      assert.equal(url.hostname, "model.example");
      assert.equal(url.protocol, "https:");
      assert.equal(url.pathname, "/v1/models");
      assert.equal(options.agent, false);
      assert.equal(options.autoSelectFamily, false);
      options.lookup("model.example", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
      options.lookup("model.example", { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]); });
      return http.request(new URL("/v1/models", local.url), options, callback);
    },
  }) });
  const gateway = await serve(t, app);
  const response = await fetch(`${gateway.url}/api/agent/cloud/models`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://model.example", apiKey: API_KEY }) });
  assert.equal(response.status, 200);
  assert.equal(lookups, 1);
  assert.equal(requests, 1);
});

test("validated DNS pools reject every mixed/private result and preserve public order", async () => {
  const endpoint = normalizeAgentCloudEndpoint("https://model.example");
  const publicPool = [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  assert.deepEqual(await resolveAgentCloudTargets(endpoint, async () => publicPool), publicPool);
  assert.deepEqual(await resolveAgentCloudTarget(endpoint, async () => publicPool), publicPool[0]);
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "fd00::1", "garbage"]) {
    await assert.rejects(resolveAgentCloudTargets(endpoint, async () => [...publicPool, { address }]), { code: "private_address" });
  }
});

test("multiple public targets pin the whole pool once for one HTTPS generation request", async (t) => {
  const pool = [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }];
  const canonical = { model: "test-model", messages: [{ role: "user", content: "generate once" }], stream: false };
  let lookups = 0, requests = 0, received = 0;
  const local = await serve(t, async (req, res) => {
    received++;
    assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(await body(req), canonical);
    json(res, 200, { choices: [{ message: { content: "one" } }] });
  });
  const app = express(); app.use(express.json());
  registerAgentCloudRoutes(app, { config: CONFIG, transport: createAgentCloudTransport({
    lookup: async (host) => { lookups++; assert.equal(host, "model.example"); return pool; },
    httpsRequest: (url, options, callback) => {
      requests++;
      assert.equal(url.hostname, "model.example"); assert.equal(url.protocol, "https:");
      assert.equal(url.pathname, "/v1/chat/completions"); assert.equal(options.agent, false);
      assert.equal(options.family, 0); assert.equal(options.autoSelectFamily, true);
      assert.equal(options.autoSelectFamilyAttemptTimeout, 300);
      // Repeated socket lookups receive the same already-validated snapshot, never DNS.
      for (let attempt = 0; attempt < 2; attempt++) options.lookup("model.example", { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, pool); });
      options.lookup("model.example", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, pool[0].address); assert.equal(family, 4); });
      return http.request(new URL("/v1/chat/completions", local.url), options, callback);
    },
  }) });
  const gateway = await serve(t, app);
  const response = await fetch(`${gateway.url}/api/agent/cloud/chat`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://model.example", apiKey: API_KEY, request: canonical }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, "one");
  assert.equal(lookups, 1); assert.equal(requests, 1); assert.equal(received, 1);
});

test("mixed DNS pool is rejected before creating any HTTPS request", async (t) => {
  let requests = 0;
  const app = express(); app.use(express.json());
  registerAgentCloudRoutes(app, { config: CONFIG, transport: createAgentCloudTransport({
    lookup: async () => [{ address: "8.8.8.8" }, { address: "1.1.1.1" }, { address: "10.0.0.1" }],
    httpsRequest: () => { requests++; throw new Error("must not connect"); },
  }) });
  const gateway = await serve(t, app);
  const response = await fetch(`${gateway.url}/api/agent/cloud/models`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://model.example", apiKey: API_KEY }) });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "private_address"); assert.equal(requests, 0);
});

test("invalid caller, payload, and key fail without contacting upstream", async (t) => {
  let calls = 0;
  const { post } = await fixture(t, (_req, res) => { calls += 1; json(res, 200, { data: [] }); });
  for (const [extra, headers, status] of [
    [{}, { origin: "http://127.0.0.1:65432" }, 403],
    [{}, { origin: "https://evil.example" }, 403],
    [{}, { origin: "null" }, 403],
    [{ apiKey: "key\r\nx-evil: value" }, {}, 400],
    [{ request: { model: "m", messages: [], stream: true } }, {}, 400],
    [{ request: { model: "m", messages: [{ role: "invalid" }] } }, {}, 400],
    [{ request: { model: "m", messages: [{ role: "user", content: "x" }], tools: {} } }, {}, 400],
    [{ request: { model: "m", messages: [{ role: "user", content: "x" }], stream: "yes" } }, {}, 400],
    [{ request: null }, {}, 400],
  ]) assert.equal((await post("chat", extra, headers)).status, status);
  assert.equal(calls, 0);
});

test("real gateway registration supports a custom canvas origin and contains malformed-JSON secrets", { timeout: 20000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-cloud-integration-"));
  const previousBootstrap = process.env.DISABLE_NODE_BOOTSTRAP;
  process.env.DISABLE_NODE_BOOTSTRAP = "1";
  let gateway;
  let server;
  const logLines = [];
  t.mock.method(console, "log", (...args) => logLines.push(args.join(" ")));
  t.after(async () => {
    if (gateway) await stopGateway({ ...gateway, server });
    server?.closeAllConnections();
    if (previousBootstrap === undefined) delete process.env.DISABLE_NODE_BOOTSTRAP;
    else process.env.DISABLE_NODE_BOOTSTRAP = previousBootstrap;
    // Only this test's verified, newly created temporary directory is removed.
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("agent-cloud-integration-"));
    await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const upstream = await serve(t, (req, res) => {
    if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "stub-model" }] });
    json(res, 401, { error: { message: `provider echoed ${API_KEY}` } });
  });
  const customOrigin = "http://localhost:18763";
  gateway = await createGatewayApp({
    desktopDistribution: true, scanOnStart: false, watchWorkflows: false,
    comfyUrl: upstream.url, corsOrigins: [customOrigin], allowRemote: false,
    workflowDir: path.join(directory, "workflows"), dataDir: path.join(directory, "data"),
    outputDir: path.join(directory, "outputs"), launcherConfigPath: path.join(directory, "launcher.json"),
  });
  const local = await serve(t, gateway.app);
  server = local.server;
  const send = (operation, body) => fetch(`${local.url}/api/agent/cloud/${operation}`, {
    method: "POST", headers: { "content-type": "application/json", origin: customOrigin }, body,
  });
  const models = await send("models", JSON.stringify({ baseUrl: upstream.url, apiKey: API_KEY }));
  assert.equal(models.status, 200);
  assert.equal(models.headers.get("access-control-allow-origin"), customOrigin);
  assert.equal((await models.json()).data[0].id, "stub-model");
  // Node's JSON parser can include the unescaped offending token in its error message.
  const malformed = await send("chat", `{ "apiKey": ${API_KEY} }`);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
  const malformedText = await malformed.text();
  assert.equal(malformedText.includes(API_KEY), false);
  assert.equal(JSON.parse(malformedText).error.code, "invalid_json");
  const rejected = await send("chat", JSON.stringify({ baseUrl: upstream.url, apiKey: API_KEY,
    request: { model: "stub-model", messages: [{ role: "user", content: "hello" }] } }));
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.text()).includes(API_KEY), false);
  assert.equal(logLines.join("\n").includes(API_KEY), false);
  // The actual gateway logger writes to console (captured to disk by launchers), not a separate logger file.
  await gateway.tasks.persistNow();
  const entries = await fsp.readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath || entry.path, entry.name);
    assert.equal((await fsp.readFile(file, "utf8")).includes(API_KEY), false, entry.name);
  }
});

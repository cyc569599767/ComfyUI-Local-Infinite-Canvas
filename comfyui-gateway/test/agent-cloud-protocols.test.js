import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { normalizeAgentCloudEndpoint, registerAgentCloudRoutes, createAgentCloudTransport, requestAgentCloudJson } from "../src/agent-cloud.js";
import { prepareAgentCloudRequest, createAgentCloudNormalizer } from "../src/agent-cloud-protocols.js";

const KEY = "fixture-key-never-real-123";
const ORIGIN = "http://127.0.0.1:3999";
const image = "data:image/png;base64,aGVsbG8=";
const tools = [{ type: "function", function: { name: "canvas_get_state", description: "Canvas", parameters: { type: "object", properties: { id: { type: "string" } } } } }];
const request = (extra = {}) => ({ model: "test-model", messages: [{ role: "system", content: "rules" }, { role: "developer", content: "more rules" }, { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: image } }] }], tools, tool_choice: "auto", max_tokens: 123, stream: false, ...extra });
const json = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
const frame = (data) => `event: ${data.type || "message"}\ndata: ${JSON.stringify(data)}\n\n`;
async function body(req) { let value = ""; for await (const part of req) value += part; return value ? JSON.parse(value) : null; }
async function serve(t, handler) {
  const server = http.createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handler, options = {}) {
  const upstream = await serve(t, handler);
  const app = express(); app.use(express.json({ limit: "50mb" }));
  registerAgentCloudRoutes(app, { config: { corsOrigins: [ORIGIN] }, transport: createAgentCloudTransport(options) });
  const gateway = await serve(t, app);
  return { upstream, gateway, post: (apiFormat, req = request(), extra = {}, signal) => fetch(`${gateway}/api/agent/cloud/chat`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ baseUrl: upstream, apiKey: KEY, apiFormat, request: req, ...extra }), signal }),
    models: (apiFormat) => fetch(`${gateway}/api/agent/cloud/models`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ baseUrl: upstream, apiKey: KEY, apiFormat }) }) };
}
function collect(sse) {
  const result = { content: "", reasoning: "", calls: [], metadata: undefined };
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const data = JSON.parse(line.slice(6)); assert.equal(data.error, undefined, line);
    const delta = data.choices?.[0]?.delta;
    if (!delta) continue;
    result.content += delta.content || ""; result.reasoning += delta.reasoning_content || "";
    if (delta.provider_metadata) result.metadata = { ...result.metadata, ...delta.provider_metadata };
    for (const call of delta.tool_calls || []) {
      const item = result.calls[call.index] ||= { id: "", function: { name: "", arguments: "" } };
      if (call.id) item.id = call.id;
      item.function.name += call.function?.name || ""; item.function.arguments += call.function?.arguments || "";
      if (call.function?.thoughtSignature) item.function.thoughtSignature = call.function.thoughtSignature;
    }
  }
  return result;
}

// All network is loopback fixture traffic. Example host strings below are never requested.
test("protocol endpoints normalize root, version, custom and full suffix without protocol guessing", () => {
  for (const format of ["openai", "grok", "responses", "anthropic", "gemini"]) {
    const suffix = format === "responses" ? "responses" : format === "anthropic" ? "messages" : format === "gemini" ? "models/test-model:streamGenerateContent" : "chat/completions";
    const version = format === "gemini" ? "v1beta" : "v1";
    for (const [base, prefix] of [["", `/${version}`], [`/${version}/`, `/${version}`], ["/proxy/custom", "/proxy/custom"], [`/proxy/${suffix}`, "/proxy"]]) {
      const url = normalizeAgentCloudEndpoint(`https://example.test${base}`, "chat", format, request({ stream: true }));
      assert.equal(url.pathname, `${prefix}/${suffix}`);
      assert.equal(url.search, format === "gemini" ? "?alt=sse" : "");
      assert.equal(normalizeAgentCloudEndpoint(`https://example.test${base}`, "models", format).pathname, `${prefix}/models`);
    }
  }
  assert.equal(normalizeAgentCloudEndpoint("https://example.test/v1beta/models/old:generateContent", "chat", "gemini", { model: "models/new", stream: false }).pathname, "/v1beta/models/new:generateContent");
  assert.equal(normalizeAgentCloudEndpoint("https://example.test/v1/responses", "chat", "grok").pathname, "/v1/chat/completions");
  assert.throws(() => normalizeAgentCloudEndpoint("https://example.test", "chat", "unknown"), { code: "invalid_api_format" });
  for (const model of ["../bad", "m?key=x", "x/y", "m#x"]) assert.throws(() => normalizeAgentCloudEndpoint("https://example.test", "chat", "gemini", { model }), { code: "invalid_model" });
});

test("Responses full JSON request maps system, images, canonical tools and continuation IDs", async (t) => {
  const output = [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "opaque-reason" }, { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "checking" }] }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "canvas_get_state", arguments: '{"id":"n1"}' }];
  let count = 0;
  const { post } = await fixture(t, async (req, res) => {
    assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["x-api-key"], undefined);
    const sent = await body(req); count++;
    assert.equal(sent.max_output_tokens, 123); assert.equal(sent.max_tokens, undefined); assert.equal(sent.store, false);
    assert.deepEqual(sent.include, ["reasoning.encrypted_content"]);
    assert.equal(sent.input[0].role, "system"); assert.equal(sent.input[1].role, "developer");
    assert.equal(sent.input[2].content[1].image_url, image); assert.equal(sent.tools[0].name, "canvas_get_state");
    if (count === 2) { assert.deepEqual(sent.input.slice(3, 6), output); assert.deepEqual(sent.input[6], { type: "function_call_output", call_id: "call_1", output: "{}" }); }
    json(res, { id: "resp_1", output, status: "completed" });
  });
  const first = await post("responses"); assert.equal(first.status, 200);
  const message = (await first.json()).choices[0].message;
  assert.equal(message.content, "checking"); assert.equal(message.reasoning_content, "plan");
  assert.equal(message.tool_calls[0].id, "call_1"); assert.deepEqual(message.provider_metadata.responses.output, output);
  assert.equal((await post("responses", request({ messages: [...request().messages, message, { role: "tool", tool_call_id: "call_1", content: "{}" }] }))).status, 200);
});

test("Gemini JSON request uses header auth, inline images, tool response names and thought signatures", async (t) => {
  const native = [{ text: "checking" }, { functionCall: { id: "g1", name: "canvas_get_state", args: { id: "n1" } }, thoughtSignature: "signature-kept" }];
  let count = 0;
  const { post } = await fixture(t, async (req, res) => {
    count++; assert.equal(req.url, "/v1beta/models/test-model:generateContent");
    assert.equal(req.headers["x-goog-api-key"], KEY); assert.equal(req.headers.authorization, undefined);
    const sent = await body(req);
    assert.equal(sent.model, undefined); assert.equal(sent.stream, undefined);
    assert.equal(sent.systemInstruction.parts.length, 2); assert.deepEqual(sent.contents[0].parts[1].inlineData, { mimeType: "image/png", data: "aGVsbG8=" });
    assert.equal(sent.generationConfig.maxOutputTokens, 123); assert.equal(sent.tools[0].functionDeclarations[0].name, "canvas_get_state");
    if (count === 2) { assert.deepEqual(sent.contents[1].parts, native); assert.deepEqual(sent.contents[2].parts[0].functionResponse, { name: "canvas_get_state", id: "g1", response: { result: { found: true } } }); }
    json(res, { candidates: [{ content: { parts: native }, finishReason: "STOP" }] });
  });
  const first = await post("gemini"); assert.equal(first.status, 200);
  const message = (await first.json()).choices[0].message;
  assert.equal(message.tool_calls[0].function.thoughtSignature, "signature-kept");
  assert.equal((await post("gemini", request({ messages: [...request().messages, message, { role: "tool", tool_call_id: "g1", content: '{"found":true}' }] }))).status, 200);
});

test("Anthropic JSON maps system, images, tool_use/tool_result and signed thinking", async (t) => {
  const content = [{ type: "thinking", thinking: "plan", signature: "signed-thought" }, { type: "text", text: "checking" }, { type: "tool_use", id: "a1", name: "canvas_get_state", input: {} }];
  let count = 0;
  const { post } = await fixture(t, async (req, res) => {
    count++; assert.equal(req.url, "/v1/messages"); assert.equal(req.headers["x-api-key"], KEY);
    assert.equal(req.headers["anthropic-version"], "2023-06-01"); assert.equal(req.headers.authorization, undefined);
    const sent = await body(req); assert.equal(sent.system.length, 2); assert.equal(sent.messages[0].content[1].source.type, "base64");
    assert.equal(sent.max_tokens, 123); assert.deepEqual(sent.tools[0].input_schema, tools[0].function.parameters);
    if (count === 2) { assert.deepEqual(sent.messages[1].content, content); assert.deepEqual(sent.messages[2].content, [{ type: "tool_result", tool_use_id: "a1", content: "ok" }]); }
    json(res, { type: "message", content, stop_reason: "tool_use" });
  });
  const first = await post("anthropic"); assert.equal(first.status, 200);
  const message = (await first.json()).choices[0].message; assert.equal(message.reasoning_content, "plan");
  assert.equal((await post("anthropic", request({ messages: [...request().messages, message, { role: "tool", tool_call_id: "a1", content: "ok" }] }))).status, 200);
});

test("grok is an explicit OpenAI chat alias, preserving canonical request", async (t) => {
  const canonical = request();
  const { post } = await fixture(t, async (req, res) => { assert.equal(req.url, "/v1/chat/completions"); assert.equal(req.headers.authorization, `Bearer ${KEY}`); assert.deepEqual(await body(req), canonical); json(res, { choices: [{ message: { content: "xAI" } }] }); });
  assert.equal((await (await post("grok", canonical)).json()).choices[0].message.content, "xAI");
});

test("Responses SSE text, sparse tool indices, argument deltas, reasoning and final metadata", async (t) => {
  const output = [{ type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "opaque" }, { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "hi中文" }] }, { type: "function_call", id: "fc1", call_id: "c1", name: "canvas_get_state", arguments: '{"id":"n1"}' }];
  const events = [{ type: "response.created", response: { id: "r1" } }, { type: "response.reasoning_summary_text.delta", delta: "plan" }, { type: "response.output_text.delta", delta: "hi中文" }, { type: "response.output_item.added", output_index: 2, item: { ...output[2], arguments: "" } }, { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"id":' }, { type: "response.function_call_arguments.delta", output_index: 2, delta: '"n1"}' }, { type: "response.output_item.done", output_index: 2, item: output[2] }, { type: "response.completed", response: { output, status: "completed" } }];
  const { post } = await fixture(t, async (req, res) => { assert.equal((await body(req)).stream, true); res.writeHead(200, { "content-type": "text/event-stream" }); const bytes = Buffer.from(events.map(frame).join("")); const split = bytes.indexOf(Buffer.from("中文")) + 1; res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split)); });
  const response = await post("responses", request({ stream: true })); assert.equal(response.status, 200);
  const result = collect(await response.text()); assert.equal(result.content, "hi中文"); assert.equal(result.reasoning, "plan");
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].function.arguments, '{"id":"n1"}');
  assert.deepEqual(result.metadata.responses.output, output);
});

test("Gemini SSE emits text, parallel tools and final full native parts for continuation", async (t) => {
  const native = [{ text: "plan", thought: true }, { text: "hello" }, { functionCall: { name: "canvas_get_state", args: {} }, thoughtSignature: "sig1" }, { functionCall: { name: "canvas_get_state", args: { id: "2" } }, thoughtSignature: "sig2" }];
  const { post } = await fixture(t, async (req, res) => {
    assert.equal(req.url, "/v1beta/models/test-model:streamGenerateContent?alt=sse"); assert.equal(req.url.includes(KEY), false);
    await body(req); res.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of native) res.write(frame({ candidates: [{ content: { parts: [part] } }] }));
    res.end(frame({ candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 8 } }));
  });
  const result = collect(await (await post("gemini", request({ stream: true }))).text());
  assert.equal(result.content, "hello"); assert.equal(result.reasoning, "plan"); assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].function.thoughtSignature, "sig1"); assert.equal(result.calls[1].id, "gemini_call_1");
  assert.deepEqual(result.metadata.gemini.parts, native);
  const next = prepareAgentCloudRequest(request({ messages: [{ role: "assistant", content: result.content, tool_calls: result.calls, provider_metadata: result.metadata }, { role: "tool", tool_call_id: result.calls[0].id, content: "ok" }, { role: "tool", tool_call_id: result.calls[1].id, content: "ok" }] }), "gemini");
  assert.equal(next.contents[1].parts.length, 2); assert.equal(next.contents[1].parts[0].functionResponse.name, "canvas_get_state");
});

test("Anthropic SSE incremental arguments and thinking signatures are not double emitted", async (t) => {
  const events = [{ type: "message_start", message: { id: "m" } }, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } }, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, { type: "content_block_stop", index: 0 }, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } }, { type: "content_block_stop", index: 1 }, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "a1", name: "canvas_get_state", input: {} } }, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"id":' } }, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"n1"}' } }, { type: "content_block_stop", index: 2 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }];
  const { post } = await fixture(t, async (req, res) => { await body(req); res.writeHead(200, { "content-type": "text/event-stream" }); res.end(events.map(frame).join("")); });
  const result = collect(await (await post("anthropic", request({ stream: true }))).text());
  assert.equal(result.content, "hello"); assert.equal(result.reasoning, "plan"); assert.equal(result.calls[0].function.arguments, '{"id":"n1"}');
  assert.deepEqual(result.metadata.anthropic.thinking, [{ type: "thinking", thinking: "plan", signature: "sig" }]);
});

test("each protocol gets only its /models endpoint and auth, Gemini filters generative models", async (t) => {
  for (const format of ["openai", "responses", "grok", "anthropic", "gemini"]) await t.test(format, async (t) => {
    const { models } = await fixture(t, async (req, res) => {
      assert.equal(req.method, "GET"); assert.equal(await body(req), null);
      assert.equal(req.url, format === "gemini" ? "/v1beta/models" : "/v1/models");
      assert.equal(req.headers[format === "gemini" ? "x-goog-api-key" : format === "anthropic" ? "x-api-key" : "authorization"], ["gemini", "anthropic"].includes(format) ? KEY : `Bearer ${KEY}`);
      json(res, format === "gemini" ? { models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }] } : { data: [{ id: "model-test" }] });
    });
    const response = await models(format); assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, [{ id: format === "gemini" ? "gemini-test" : "model-test", object: "model" }]);
  });
});

test("invalid types, protocols, unsafe URLs and unsupported tools fail before any upstream request", async (t) => {
  let count = 0;
  const { post } = await fixture(t, (_req, res) => { count++; json(res, {}); });
  for (const format of ["bogus", null, 1]) assert.equal((await post(format)).status, 400);
  for (const format of ["gemini", "responses", "anthropic", "grok"]) {
    for (const invalid of [{ messages: [{ role: "user", content: {} }] }, { tools: [{ type: "code_interpreter" }] }, { max_tokens: "123" }, { tool_choice: {} }, { messages: [{ role: "assistant", content: "x", provider_metadata: [] }] }, { messages: [{ role: "assistant", tool_calls: [{ id: "x", function: { name: "f", arguments: "bad" } }] }] }]) assert.equal((await post(format, request(invalid))).status, 400);
    for (const baseUrl of ["https://10.0.0.1", "https://example.test?key=oops", "https://example.test#x", "http://example.test", "https://u:p@example.test"]) assert.equal((await post(format, request(), { baseUrl })).status, 400);
  }
  assert.equal(count, 0);
});

test("nonchat provider errors are fixed and metadata echo cannot leak the API key", async (t) => {
  for (const format of ["responses", "gemini", "anthropic"]) await t.test(format, async (t) => {
    const { post } = await fixture(t, async (req, res) => { await body(req); res.writeHead(200, { "content-type": "text/event-stream" }); res.end(frame({ type: "error", error: { message: KEY } })); });
    const response = await post(format); const text = await response.text(); assert.equal(text.includes(KEY), false); assert.match(text, /upstream_status/);
  });
  await t.test("redact continuation", async (t) => {
    const { post } = await fixture(t, (_req, res) => json(res, { candidates: [{ content: { parts: [{ text: KEY, thoughtSignature: KEY }] } }] }));
    const text = await (await post("gemini")).text(); assert.equal(text.includes(KEY), false); assert.match(text, /redacted/);
  });
});

test("nonchat cancellation destroys upstream without waiting for final metadata", { timeout: 4000 }, async (t) => {
  for (const format of ["responses", "gemini", "anthropic"]) await t.test(format, async (t) => {
    let closed; const ended = new Promise((resolve) => { closed = resolve; });
    const { post } = await fixture(t, async (req, res) => {
      await body(req); res.on("close", closed); res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(format === "responses" ? { type: "response.output_text.delta", delta: "start" } : format === "gemini" ? { candidates: [{ content: { parts: [{ text: "start" }] } }] } : { type: "content_block_start", index: 0, content_block: { type: "text", text: "start" } }));
    });
    const controller = new AbortController(); const response = await post(format, request({ stream: true }), {}, controller.signal);
    await response.body.getReader().read(); controller.abort(); await ended;
  });
});

test("internal JSON consumer forces nonstream, reuses guarded protocol transport and redacts", async (t) => {
  const upstream = await serve(t, async (req, res) => {
    assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal((await body(req)).stream, false);
    json(res, { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `optimized ${KEY}` }] }] });
  });
  const result = await requestAgentCloudJson({ baseUrl: upstream, apiKey: KEY, apiFormat: "responses", request: request({ stream: true }) });
  assert.equal(result.choices[0].message.content, "optimized [redacted]");
  await assert.rejects(requestAgentCloudJson({ baseUrl: "https://10.0.0.1", apiFormat: "responses", request: request() }), { code: "private_address" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestAgentCloudJson({ baseUrl: upstream, apiFormat: "responses", request: request() }, { signal: controller.signal }));
});

test("Responses final-only and done-only tools reconcile by call ID without duplicate arguments", () => {
  const item = { type: "function_call", id: "fc", call_id: "c", name: "canvas_get_state", arguments: '{"id":"n"}' };
  for (const mode of ["final", "done", "added"]) {
    const normalizer = createAgentCloudNormalizer("responses"); const events = [];
    if (mode === "done") events.push(...normalizer.event({ type: "response.output_item.done", output_index: 3, item }));
    if (mode === "added") events.push(...normalizer.event({ type: "response.output_item.added", output_index: 3, item: { ...item, arguments: '{"id":' } }));
    events.push(...normalizer.event({ type: "response.completed", response: { output: [item] } }));
    const result = collect(events.map(frame).join(""));
    assert.equal(result.calls.length, 1, mode); assert.equal(result.calls[0].function.arguments, item.arguments, mode);
  }
});

test("normalized SSE budgets include generated continuation metadata", async (t) => {
  const { post } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 0; index < 4; index++) res.write(frame({ candidates: [{ content: { parts: [{ text: "x".repeat(80) }] } }] }));
    res.end();
  }, { maxEventBytes: 300 });
  const result = await (await post("gemini", request({ stream: true }))).text();
  assert.match(result, /event_too_large/); assert.equal(result.includes(KEY), false);
});

test("adapters map explicit tool choices and reject malformed output without inventing code tools", () => {
  assert.deepEqual(prepareAgentCloudRequest(request({ tool_choice: { type: "function", function: { name: "canvas_get_state" } } }), "responses").tool_choice, { type: "function", name: "canvas_get_state" });
  assert.deepEqual(prepareAgentCloudRequest(request({ tool_choice: "required" }), "gemini").toolConfig, { functionCallingConfig: { mode: "ANY" } });
  assert.deepEqual(prepareAgentCloudRequest(request({ tool_choice: "required", parallel_tool_calls: false }), "anthropic").tool_choice, { type: "any", disable_parallel_tool_use: true });
  const response = createAgentCloudNormalizer("responses").json({ output: [{ type: "code_interpreter_call", id: "ci1" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
  assert.equal(response.choices[0].message.tool_calls, undefined);
  for (const format of ["gemini", "responses", "anthropic"]) assert.throws(() => createAgentCloudNormalizer(format).json({ wrong: true }), { code: "invalid_response" });
});

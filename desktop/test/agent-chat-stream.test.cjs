'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readAgentChatResponse, redactAgentError } = require('../../infinite-canvas/web/src/lib/agent-chat-stream.ts');

const encoder = new TextEncoder();
const emptyReply = { content: '', reasoning: '', toolCalls: [] };
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value, rest = {}) => ({ choices: [{ delta: value, ...rest }] });
const jsonResponse = (data, options = {}) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json' }, ...options,
});
function streamResponse(chunks, options = {}) {
  let cancelled = false;
  let cancelReason;
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      if (!options.open) controller.close();
    },
    cancel(reason) { cancelled = true; cancelReason = reason; },
  });
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' }, status: options.status || 200 }),
    stream,
    cancelled: () => cancelled,
    cancelReason: () => cancelReason,
  };
}
function byteChunks(text, size = 1) {
  const bytes = encoder.encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}
async function errorFrom(promise) {
  try { await promise; }
  catch (error) { return error; }
  assert.fail('Expected a rejected response');
}

// All fixtures are real WHATWG Response/ReadableStream objects, not reader mocks.
test('SSE streams text/reasoning across every byte boundary, including UTF-8 and CRLF', async () => {
  const text = ': keepalive\r\nevent: message\r\n'
    + frame(delta({ role: 'assistant' })).replaceAll('\n', '\r\n')
    + frame(delta({ reasoning_content: '想🤔' })).replaceAll('\n', '\r\n')
    + frame(delta({ reasoning: '一下' })).replaceAll('\n', '\r\n')
    + frame(delta({ content: '你好🌍' })).replaceAll('\n', '\r\n')
    + frame(delta({ content: '!' })).replaceAll('\n', '\r\n')
    + 'data: [DONE]\r\n\r\n';
  const fixture = streamResponse(byteChunks(text));
  const seen = [];
  assert.deepEqual(await readAgentChatResponse(fixture.response, { onDelta: (value) => seen.push(value) }), {
    content: '你好🌍!', reasoning: '想🤔一下', toolCalls: [],
  });
  assert.deepEqual(seen, [{ reasoning: '想🤔' }, { reasoning: '一下' }, { content: '你好🌍' }, { content: '!' }]);
  assert.equal(fixture.stream.locked, false);
});

test('accepts a final data frame without newline and no DONE marker', async () => {
  const fixture = streamResponse([`data: ${JSON.stringify(delta({ content: 'last frame' }))}`]);
  assert.deepEqual(await readAgentChatResponse(fixture.response), { ...emptyReply, content: 'last frame' });
  assert.equal(fixture.stream.locked, false);
});

test('accepts SSE EOF after a valid choice with or without finish_reason', async (t) => {
  for (const final of ['', frame({ choices: [{ finish_reason: 'stop' }] }), frame(delta({}, { finish_reason: 'stop' }))]) {
    await t.test(`final: ${JSON.stringify(final)}`, async () => {
      const fixture = streamResponse([frame(delta({ content: 'complete' })), final]);
      assert.equal((await readAgentChatResponse(fixture.response)).content, 'complete');
      assert.equal(fixture.stream.locked, false);
    });
  }
});

test('DONE without trailing newline ends immediately and cancels an open reader', async () => {
  const fixture = streamResponse([frame(delta({ content: 'complete' })), 'data: [DONE]\n'], { open: true });
  assert.equal((await readAgentChatResponse(fixture.response)).content, 'complete');
  assert.equal(fixture.cancelled(), true);
  assert.equal(fixture.stream.locked, false);
});

test('DONE is terminal; later frames are neither processed nor emitted', async () => {
  const fixture = streamResponse([frame(delta({ content: 'safe' })) + 'data: [DONE]\n\n'
    + frame({ error: { message: 'must not be processed' } })], { open: true });
  const seen = [];
  assert.equal((await readAgentChatResponse(fixture.response, { onDelta: (d) => seen.push(d) })).content, 'safe');
  assert.deepEqual(seen, [{ content: 'safe' }]);
  assert.equal(fixture.cancelled(), true);
});

test('supports final DONE frame with neither trailing newline nor blank separator', async () => {
  const fixture = streamResponse([frame(delta({ content: 'ok' })) + 'data: [DONE]']);
  assert.equal((await readAgentChatResponse(fixture.response)).content, 'ok');
});

test('supports multiple data lines per JSON event and single-LF JSON frames', async () => {
  const text = 'data: {"choices":\r\ndata: [{"delta":{"content":"multi"}}]}\r\n\r\n'
    + `data: ${JSON.stringify(delta({ content: '-line' }))}\n`
    + `data: ${JSON.stringify(delta({ content: '!' }))}\n`;
  assert.equal((await readAgentChatResponse(streamResponse(byteChunks(text, 7)).response)).content, 'multi-line!');
});

test('content arrays retain existing text behavior for SSE and JSON', async () => {
  const content = [{ type: 'text', text: 'one' }, { text: 2 }, { text: false }, { text: { a: 1 } }, null, 'ignored', { image_url: 'ignored' }];
  for (const response of [jsonResponse({ choices: [{ message: { content } }] }), streamResponse([frame(delta({ content }))]).response]) {
    assert.equal((await readAgentChatResponse(response)).content, 'one2[object Object]');
  }
});

test('reassembles fragmented tool arguments and concatenates tool name deltas in index order', async () => {
  const fixture = streamResponse(byteChunks(
    frame(delta({ tool_calls: [{ index: 1, id: 'call-b', function: { name: 'sec', arguments: '{"b":' } }] }))
    + frame(delta({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'fir', arguments: '{"a":"' } }] }))
    + frame(delta({ tool_calls: [{ index: 1, function: { name: 'ond', arguments: '2}' } }, { index: 0, function: { name: 'st', arguments: '中"}' } }] }))
    + frame(delta({}, { finish_reason: 'tool_calls' })) + 'data: [DONE]\n\n', 3));
  const seen = [];
  assert.deepEqual(await readAgentChatResponse(fixture.response, { onDelta: (d) => seen.push(d) }), {
    ...emptyReply,
    toolCalls: [
      { id: 'call-a', function: { name: 'first', arguments: '{"a":"中"}' } },
      { id: 'call-b', function: { name: 'second', arguments: '{"b":2}' } },
    ],
  });
  assert.deepEqual(seen, []);
});

test('tool calls accept fallback indices, index 127 and default empty arguments', async () => {
  const fixture = streamResponse([frame(delta({ tool_calls: [
    { id: 'one', function: { name: 'first' } },
    { index: 127, id: 'last', function: { name: 'last', arguments: '{}' } },
  ] }))]);
  assert.deepEqual((await readAgentChatResponse(fixture.response)).toolCalls, [
    { id: 'one', function: { name: 'first', arguments: '{}' } },
    { id: 'last', function: { name: 'last', arguments: '{}' } },
  ]);
});

test('rejects negative, fractional, non-number and overflowing tool indices', async (t) => {
  for (const index of [-1, 0.5, 128, 2 ** 32, '1', null]) {
    await t.test(`index ${JSON.stringify(index)}`, async () => {
      const fixture = streamResponse([frame(delta({ tool_calls: [{ index, function: { name: 'unsafe' } }] }))], { open: true });
      await assert.rejects(readAgentChatResponse(fixture.response), /index.*0 to 127/);
      assert.equal(fixture.cancelled(), true);
      assert.equal(fixture.stream.locked, false);
    });
  }
});

test('rejects 129 tools in either JSON or SSE without huge sparse allocations', async () => {
  const tool_calls = Array.from({ length: 129 }, (_, i) => ({ id: `call-${i}`, function: { name: 'test', arguments: '{}' } }));
  for (const response of [jsonResponse({ choices: [{ message: { tool_calls } }] }), streamResponse([frame(delta({ tool_calls }))]).response]) {
    await assert.rejects(readAgentChatResponse(response), /maximum 128/);
  }
});

test('rejects malformed/truncated tool argument JSON instead of returning partial tool calls', async () => {
  for (const args of ['{"unfinished":', '{invalid}', 'not-json']) {
    const fixture = streamResponse([frame(delta({ tool_calls: [{ index: 0, function: { name: 'test', arguments: args } }] })), 'data: [DONE]\n']);
    await assert.rejects(readAgentChatResponse(fixture.response), /Malformed or truncated tool-call JSON/);
  }
});

test('rejects incomplete tool names and invalid field types', async () => {
  for (const call of [{ id: 'only-id' }, { function: { arguments: '{}' } }, { function: { name: 4 } }, { function: { name: 'x', arguments: {} } }, null]) {
    await assert.rejects(readAgentChatResponse(streamResponse([frame(delta({ tool_calls: [call] }))]).response), /tool.call/i);
  }
});

test('JSON fallback streams reasoning then content and returns tools', async () => {
  const seen = [];
  const response = jsonResponse({ choices: [{ message: {
    content: 'answer', reasoning_content: 'reason', reasoning: 'ignored',
    tool_calls: [{ id: 'call', function: { name: 'tool', arguments: '{"x":1}' } }],
  } }] });
  assert.deepEqual(await readAgentChatResponse(response, { onDelta: (d) => seen.push(d) }), {
    content: 'answer', reasoning: 'reason', toolCalls: [{ id: 'call', function: { name: 'tool', arguments: '{"x":1}' } }],
  });
  assert.deepEqual(seen, [{ reasoning: 'reason' }, { content: 'answer' }]);
  assert.equal(response.body.locked, false);
});

test('JSON fallback accepts missing content-type and split UTF-8 bytes', async () => {
  const text = JSON.stringify({ choices: [{ message: { content: '你好💡', reasoning: 'why' } }] });
  const fixture = streamResponse(byteChunks(text));
  fixture.response.headers.delete('content-type');
  assert.deepEqual(await readAgentChatResponse(fixture.response), { content: '你好💡', reasoning: 'why', toolCalls: [] });
});

test('SSE message fallback preserves content and reasoning but does not duplicate active deltas', async () => {
  const message = { content: 'snapshot', reasoning: 'thoughts' };
  const seen = [];
  assert.deepEqual(await readAgentChatResponse(streamResponse([frame({ choices: [{ message }] })]).response, { onDelta: (d) => seen.push(d) }), {
    ...emptyReply, content: 'snapshot', reasoning: 'thoughts',
  });
  assert.deepEqual(seen, [{ reasoning: 'thoughts' }, { content: 'snapshot' }]);
  assert.deepEqual(await readAgentChatResponse(streamResponse([frame(delta({ content: 'live' })), frame({ choices: [{ message }] })]).response), {
    ...emptyReply, content: 'live',
  });
});

test('empty choices usage chunks are accepted only alongside a real reply', async () => {
  const usage = frame({ choices: [], usage: { completion_tokens: 1 } });
  assert.equal((await readAgentChatResponse(streamResponse([usage, frame(delta({ content: 'hi' })), usage]).response)).content, 'hi');
  await assert.rejects(readAgentChatResponse(streamResponse([usage, 'data: [DONE]\n']).response), /no message choices/);
});

test('empty and missing choices/invalid JSON bodies produce actionable errors', async (t) => {
  const bodies = ['', ' ', 'null', '[]', '{}', '{"choices":[]}', '{"choices":[{}]}', '{"choices":[{"message":{}}]}', '{"choices":'];
  for (const body of bodies) {
    await t.test(JSON.stringify(body), async () => {
      const error = await errorFrom(readAgentChatResponse(new Response(body)));
      assert.match(error.message, /Check the chat-completions endpoint and model, then retry/);
      assert.equal(error.cause, undefined);
    });
  }
  await assert.rejects(readAgentChatResponse(new Response(null)), /empty response/);
});

test('empty and structurally invalid SSE bodies never silently succeed', async () => {
  for (const body of ['', ': heartbeat\n\n', 'data: [DONE]\n', frame({}), frame({ choices: [null] }), frame({ choices: [{ delta: 'bad' }] }), frame(delta({ role: 'assistant' }))]) {
    await assert.rejects(readAgentChatResponse(streamResponse([body]).response), /Check the chat-completions endpoint/);
  }
});

test('malformed JSON frame or final truncated frame rejects even after valid content', async () => {
  const key = 'fixture-secret-[.*]';
  for (const bad of [`data: {"secret":"${key}",bad}\n\n`, `data: {"secret":"${key}"`, 'data: not-json\n\n']) {
    const fixture = streamResponse([frame(delta({ content: 'partial' })), bad]);
    const error = await errorFrom(readAgentChatResponse(fixture.response, { apiKey: key }));
    assert.match(error.message, /Malformed or truncated JSON/);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.message.includes('secret'), false);
    assert.equal(error.cause, undefined);
    assert.equal(fixture.stream.locked, false);
  }
});

test('invalid/truncated UTF-8 rejects instead of inserting replacement characters', async () => {
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xe4, 0xbd])]) {
    const fixture = streamResponse([frame(delta({ content: 'partial' })), bytes]);
    await assert.rejects(readAgentChatResponse(fixture.response), /invalid or truncated UTF-8/);
    assert.equal(fixture.stream.locked, false);
  }
});

test('JSON and SSE API errors redact every occurrence of the exact configured key', async () => {
  const key = 'vendor.token+[.*]$?=sensitive';
  for (const [kind, status] of [['json', 200], ['json', 401], ['sse', 200], ['sse', 429]]) {
    const payload = { error: { message: `Invalid key ${key}; repeated ${key}. Please reconfigure credentials.` }, choices: [{ message: { content: 'must not emit' } }] };
    const response = kind === 'json' ? jsonResponse(payload, { status }) : streamResponse([frame(payload)], { status }).response;
    const seen = [];
    const error = await errorFrom(readAgentChatResponse(response, { apiKey: key, onDelta: (d) => seen.push(d) }));
    assert.match(error.message, /Invalid key \[REDACTED\]; repeated \[REDACTED\]/);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.stack.includes(key), false);
    assert.equal(error.cause, undefined);
    assert.deepEqual(seen, []);
    assert.equal(response.body.locked, false);
  }
});

test('SSE event:error and string/opaque error payloads never become a successful reply', async () => {
  const key = 'exact-key-123';
  const payloads = [frame({ error: `${key} rejected` }), frame({ error: {} }), `event: error\ndata: ${JSON.stringify({ message: `${key} rejected` })}\n\n`];
  for (const payload of payloads) {
    const error = await errorFrom(readAgentChatResponse(streamResponse([payload]).response, { apiKey: key }));
    assert.equal(error.message.includes(key), false);
    assert.match(error.message, /REDACTED|API/);
  }
});

test('non-JSON HTTP failures do not persist or echo raw error bodies', async () => {
  const key = 'private-exact-token';
  const response = new Response(`<html>private account details ${key}</html>`, { status: 502 });
  const error = await errorFrom(readAgentChatResponse(response, { apiKey: key }));
  assert.match(error.message, /HTTP 502/);
  assert.equal(error.message.includes('private account'), false);
  assert.equal(error.message.includes(key), false);
  assert.equal(error.cause, undefined);
});

test('redaction handles regexp characters, escaped keys, bearer tokens and bounds diagnostics', () => {
  const key = 'secret."\\[.*]$';
  const message = `${key} ${key} ${JSON.stringify(key).slice(1, -1)} ${encodeURIComponent(key)} Bearer unrelated-token sk-another-token`;
  const safe = redactAgentError(message, key);
  assert.equal(safe.includes(key), false);
  assert.equal(safe.includes(JSON.stringify(key).slice(1, -1)), false);
  assert.equal(safe.includes(encodeURIComponent(key)), false);
  assert.equal(safe.includes('unrelated-token'), false);
  assert.equal(safe.includes('sk-another-token'), false);
  assert.equal(redactAgentError('no credentials', ''), 'no credentials');
  assert.ok(redactAgentError('x'.repeat(5000) + key, key).length <= 1025);
});

test('abort interrupts a pending reader, cancels it and releases the lock without leaking reason', async () => {
  const controller = new AbortController();
  let notifyRead;
  const reading = new Promise((resolve) => { notifyRead = resolve; });
  let cancelled = false;
  const stream = new ReadableStream({
    pull() { notifyRead(); return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const pending = readAgentChatResponse(response, { signal: controller.signal, apiKey: 'secret-reason' });
  await reading;
  controller.abort(new Error('secret-reason'));
  const error = await errorFrom(pending);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message.includes('secret-reason'), false);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('abort interrupts pending JSON fallback and HTTP error reads too', async () => {
  for (const status of [200, 500]) {
    const controller = new AbortController();
    let notifyRead;
    const reading = new Promise((resolve) => { notifyRead = resolve; });
    let cancelled = false;
    const stream = new ReadableStream({ pull() { notifyRead(); }, cancel() { cancelled = true; } });
    const pending = readAgentChatResponse(new Response(stream, { status }), { signal: controller.signal });
    await reading;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test('pre-aborted signals cancel the body and never emit deltas', async () => {
  const controller = new AbortController();
  controller.abort('private reason');
  const fixture = streamResponse([frame(delta({ content: 'no' }))], { open: true });
  const seen = [];
  await assert.rejects(readAgentChatResponse(fixture.response, { signal: controller.signal, onDelta: (d) => seen.push(d) }), { name: 'AbortError' });
  assert.equal(fixture.cancelled(), true);
  assert.equal(fixture.stream.locked, false);
  assert.deepEqual(seen, []);
});

test('abort inside onDelta stops subsequent callbacks and releases the reader', async () => {
  const controller = new AbortController();
  const fixture = streamResponse([frame(delta({ content: 'answer', reasoning: 'why' }))], { open: true });
  const seen = [];
  await assert.rejects(readAgentChatResponse(fixture.response, { signal: controller.signal, onDelta: (d) => { seen.push(d); controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(seen, [{ reasoning: 'why' }]);
  assert.equal(fixture.stream.locked, false);
});

test('reader and callback failures are redacted and leave the body unlocked', async () => {
  const key = 'fixture-private-value';
  const stream = new ReadableStream({ start(controller) { controller.error(new Error(`Read failed: ${key}`)); } });
  const error = await errorFrom(readAgentChatResponse(new Response(stream), { apiKey: key }));
  assert.equal(error.message, 'Read failed: [REDACTED]');
  assert.equal(stream.locked, false);
  const fixture = streamResponse([frame(delta({ content: 'ok' }))], { open: true });
  const callbackError = await errorFrom(readAgentChatResponse(fixture.response, { apiKey: key, onDelta() { throw new Error(key); } }));
  assert.equal(callbackError.message, '[REDACTED]');
  assert.equal(fixture.cancelled(), true);
  assert.equal(fixture.stream.locked, false);
});

test('exactly 8 MiB JSON is allowed; one extra byte is rejected', async () => {
  const prefix = '{"choices":[{"message":{"content":"';
  const suffix = '"}}]}';
  const max = 8 * 1024 * 1024;
  const length = max - encoder.encode(prefix + suffix).byteLength;
  const exact = prefix + 'x'.repeat(length) + suffix;
  assert.equal((await readAgentChatResponse(new Response(exact))).content.length, length);
  await assert.rejects(readAgentChatResponse(new Response(exact + ' ')), /8 MiB/);
});

test('SSE limit is cumulative bytes (including comments) and cancels promptly', async () => {
  const megabyte = ':'.padEnd(1024 * 1024 - 1, 'x') + '\n';
  const fixture = streamResponse([...Array(8).fill(megabyte), 'x'], { open: true });
  await assert.rejects(readAgentChatResponse(fixture.response), /8 MiB/);
  assert.equal(fixture.cancelled(), true);
  assert.equal(fixture.stream.locked, false);
});

test('byte limit counts encoded bytes, not UTF-16 characters', async () => {
  const body = JSON.stringify({ choices: [{ message: { content: '中'.repeat(3 * 1024 * 1024) } }] });
  assert.ok(body.length < 8 * 1024 * 1024);
  await assert.rejects(readAgentChatResponse(new Response(body)), /8 MiB/);
});

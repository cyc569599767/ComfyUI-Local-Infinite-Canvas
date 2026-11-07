import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import path from "node:path";
import { executeLocalPrompt, normalizeLocalPromptTimeoutSeconds } from "../src/prompt-local-timeout.js";
import { createPromptOptimizer } from "../src/prompt-optimizer.js";
import h3ObjectInfo from "./fixtures/h3-prompt-object-info.json" with { type: "json" };

const rootDir = path.resolve(import.meta.dirname, "..");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const success = () => ({ status: { completed: true }, outputs: { "4": { text: ["一只猫"] } } });

// A fake clock with microtask turns between timers; never waits for real model
// execution, the public 30s minimum, or the independent cancellation grace.
function clock(t) {
  let now = 0, nextId = 0;
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
    timers, scheduled,
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

function localMock(overrides = {}) {
  const calls = { submit: [], history: [], cancel: [], interrupt: [], objectInfo: [] };
  const comfy = {
    objectInfo: async (options) => { calls.objectInfo.push(options); return structuredClone(h3ObjectInfo); },
    submit: async (workflow, options) => { calls.submit.push({ workflow, ...options }); return { promptId: "local-id" }; },
    history: async (id, options) => { calls.history.push({ id, ...options }); return success(); },
    cancel: async (id, options) => { calls.cancel.push({ id, ...options }); },
    interrupt: async (id, options) => { calls.interrupt.push({ id, ...options }); },
    ...overrides,
  };
  return { comfy, calls };
}
const run = (comfy, options = {}) => executeLocalPrompt({ comfy, workflow: {}, ...options });
const optimizer = (comfy, options = {}) => createPromptOptimizer({ config: { rootDir }, comfy, ...options });
const invoke = (instance, method, options = {}) => instance[method]({ prompt: "一只猫", uploadedImages: [{ name: "cat.png" }], ...options });

// Same accepted syntax and range as cloud, but a local-only error code.
test("local timeout defaults to 600 and validates integer number/multipart strings", () => {
  for (const value of [undefined, null, ""]) assert.equal(normalizeLocalPromptTimeoutSeconds(value), 600);
  for (const value of [30, "30", 600, "600", " 900 ", 1800, "1800"]) assert.equal(normalizeLocalPromptTimeoutSeconds(value), Number(value));
  for (const value of [0, 29, 1801, -1, 30.5, NaN, Infinity, true, false, [], [600], {}, " ", "600s", "30.1", "6e2", "0x258", "Infinity", "null"]) {
    assert.throws(() => normalizeLocalPromptTimeoutSeconds(value), { status: 400, code: "local_invalid_timeout" }, String(value));
  }
});

for (const timeoutSeconds of [undefined, "900", 1800]) test(`success uses ${timeoutSeconds ?? "default 600"} seconds with no leaked listener/timer`, async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const { comfy, calls } = localMock();
  const result = await run(comfy, { timeoutSeconds, signal: controller.signal });
  assert.deepEqual(result, { history: success(), promptId: "local-id", elapsedMs: 0 });
  assert.deepEqual(time.scheduled, [Number(timeoutSeconds ?? 600) * 1000]);
  assert.equal(calls.submit[0].signal, calls.history[0].signal);
  assert.notEqual(calls.submit[0].signal, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(calls.submit[0].signal, "abort").length, 0);
  assert.equal(time.timers.size, 0);
  controller.abort();
  await flush();
  assert.equal(calls.cancel.length, 0);
});

for (const method of ["optimize", "optimizeImage", "captionImage"]) {
  test(`${method} succeeds beyond the removed 180s ceiling and preserves sanitization`, async (t) => {
    const time = clock(t);
    let graph;
    const { comfy, calls } = localMock({
      submit: async (workflow) => { graph = workflow; return { promptId: "long-running" }; },
      history: () => new Promise((resolve) => setTimeout(() => resolve({ status: { status_str: "success" }, outputs: { "4": { text: ["<think>internal</think>一只猫"] } } }), 181000)),
    });
    const pending = invoke(optimizer(comfy), method);
    await time.tick(181000);
    const result = await pending;
    assert.equal(result.prompt, "一只猫");
    assert.equal(result.elapsedMs, 181000);
    assert.equal(calls.cancel.length, 0);
    assert.equal(time.timers.size, 0);
    if (method !== "optimizeImage") assert.equal(graph["3"].inputs.force_offload, true);
    else assert.equal(graph["1"].inputs["生成后自动卸载模型"], true);
  });

  test(`${method} rejects invalid local timeout before any Comfy request`, async () => {
    const { comfy, calls } = localMock();
    await assert.rejects(invoke(optimizer(comfy), method, { localTimeoutSeconds: "1801" }), { code: "local_invalid_timeout", status: 400 });
    assert.equal(calls.objectInfo.length + calls.submit.length + calls.history.length, 0);
  });

  test(`${method} ignores invalid local timeout entirely for cloud`, async () => {
    let requests = 0;
    const instance = optimizer(null, { cloudFetch: async () => {
      requests++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "一只猫" } }] }) };
    } });
    const result = await invoke(instance, method, {
      engine: "cloud", localTimeoutSeconds: "not-valid", cloudImages: ["data:image/png;base64,AAAA"],
      cloud: { baseUrl: "https://example.test", apiKey: "test-only", model: "mock" },
    });
    assert.equal(result.prompt, "一只猫");
    assert.equal(requests, 1);
  });

  test(`${method} history hang times out, aborts request and awaits one targeted cancellation`, async (t) => {
    const time = clock(t);
    let historySignal, settled = false;
    const cancelling = deferred();
    const { comfy, calls } = localMock({
      history: (_id, { signal }) => { historySignal = signal; return new Promise(() => {}); },
      cancel: (id, options) => { calls.cancel.push({ id, ...options }); return cancelling.promise; },
    });
    const pending = assert.rejects(invoke(optimizer(comfy), method, { localTimeoutSeconds: "30" }), {
      status: 504, code: method === "captionImage" ? "caption_timeout" : "prompt_optimize_timeout",
    }).then(() => { settled = true; });
    await time.tick(30000);
    assert.equal(historySignal.aborted, true);
    assert.equal(settled, false, "response waits for targeted cancellation");
    assert.equal(calls.cancel.length, 1);
    assert.equal(calls.cancel[0].id, "local-id");
    assert.equal(calls.cancel[0].signal.aborted, false, "cleanup uses a fresh signal");
    cancelling.resolve();
    await pending;
    assert.equal(calls.interrupt.length, 0);
    assert.equal(time.timers.size, 0);
  });
}

for (const phase of ["preflight", "submit", "history", "delay"]) test(`user abort during ${phase} is bounded and cancels only a known ID`, async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const never = () => new Promise(() => {});
  const { comfy, calls } = localMock({
    ...(phase === "submit" ? { submit: never } : {}),
    ...(phase === "history" ? { history: never } : {}),
    ...(phase === "delay" ? { history: async () => null } : {}),
  });
  const pending = assert.rejects(run(comfy, { signal: controller.signal, preflight: phase === "preflight" ? never : undefined }), { status: 400, code: "cancelled" });
  await flush();
  controller.abort();
  await pending;
  assert.equal(calls.cancel.length, ["history", "delay"].includes(phase) ? 1 : 0);
  assert.equal(calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("pre-aborted helper and all three Comfy entry points never preflight/submit/cancel", async (t) => {
  const time = clock(t);
  const { comfy, calls } = localMock();
  let preflights = 0;
  const signal = AbortSignal.abort();
  await assert.rejects(run(comfy, { signal, preflight: () => { preflights++; } }), { code: "cancelled" });
  for (const method of ["optimize", "optimizeImage", "captionImage"]) await assert.rejects(invoke(optimizer(comfy), method, { signal }), { code: "cancelled" });
  assert.equal(preflights, 0);
  assert.equal(calls.objectInfo.length + calls.submit.length + calls.cancel.length + calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
});

test("H3 preflight hang shares total budget, receives signal and never submits", async (t) => {
  const time = clock(t);
  let preflightSignal;
  const { comfy, calls } = localMock({ objectInfo: ({ signal }) => { preflightSignal = signal; return new Promise(() => {}); } });
  const pending = assert.rejects(invoke(optimizer(comfy), "optimize", { localTimeoutSeconds: 30 }), { code: "prompt_optimize_timeout" });
  await time.tick(30000);
  await pending;
  assert.equal(preflightSignal.aborted, true);
  assert.equal(calls.submit.length + calls.cancel.length + calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
});

test("preflight and submission consume the same total budget as history", async (t) => {
  const time = clock(t);
  const { comfy, calls } = localMock({ submit: () => new Promise((resolve) => setTimeout(() => resolve({ promptId: "local-id" }), 15000)), history: () => new Promise(() => {}) });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30, preflight: () => new Promise((resolve) => setTimeout(resolve, 10000)) }), { code: "local_prompt_timeout" });
  await time.tick(30000);
  await pending;
  assert.equal(calls.cancel.length, 1);
  assert.deepEqual(time.scheduled, [30000, 10000, 15000, 10000]);
});

for (const reason of ["timeout", "abort"]) test(`${reason} reports cancellation rejection as local_cancel_failed instead of silent timeout`, async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const { comfy, calls } = localMock({
    history: () => new Promise(() => {}),
    cancel: async (id) => { calls.cancel.push({ id }); throw new Error("cancel transport unavailable"); },
  });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30, signal: controller.signal }), (error) => {
    assert.equal(error.code, "local_cancel_failed");
    assert.equal(error.status, 502);
    assert.equal(error.details.promptId, "local-id");
    assert.match(error.message, /cancel transport unavailable/);
    return true;
  });
  if (reason === "timeout") await time.tick(30000);
  else { await flush(); controller.abort(); }
  await pending;
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
});

test("user abort followed by deadline while cancellation is pending still cancels exactly once", async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const cancellation = deferred();
  const { comfy, calls } = localMock({ history: () => new Promise(() => {}), cancel: (id) => { calls.cancel.push({ id }); return cancellation.promise; } });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30, signal: controller.signal }), { code: "cancelled" });
  await time.tick(29000);
  controller.abort();
  await time.tick(2000);
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["local-id"]);
  cancellation.resolve();
  await pending;
  assert.equal(time.timers.size, 0);
});

test("deadline cancels a polling delay and never treats late history success as success", async (t) => {
  const time = clock(t);
  const historyResult = deferred();
  let polls = 0;
  const { comfy, calls } = localMock({ history: () => { polls++; return polls === 1 ? Promise.resolve(null) : historyResult.promise; } });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30 }), { code: "local_prompt_timeout" });
  await time.tick(30000);
  await pending;
  historyResult.resolve(success());
  await flush();
  assert.equal(polls, 2);
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["local-id"]);
  assert.equal(time.timers.size, 0);
});

test("outputs without any terminal status poll until the deadline, cancelling once", async (t) => {
  const time = clock(t);
  let polls = 0;
  const { comfy, calls } = localMock({ history: async () => { polls++; return { outputs: { "2": { text: ["Intermediate TE template"] } } }; } });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30 }), { code: "local_prompt_timeout" });
  await time.tick(30000);
  await pending;
  assert.equal(polls, 30);
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["local-id"]);
  assert.equal(time.timers.size, 0);
});

test("cancellation itself is bounded even when client ignores cleanup signal", async (t) => {
  const time = clock(t);
  const { comfy, calls } = localMock({ history: () => new Promise(() => {}), cancel: (id, options) => { calls.cancel.push({ id, ...options }); return new Promise(() => {}); } });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30 }), { code: "local_cancel_failed" });
  await time.tick(40000);
  await pending;
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.cancel[0].signal.aborted, true);
  assert.equal(time.timers.size, 0);
});

for (const reason of ["timeout", "abort"]) test(`late submit acknowledgement after ${reason} is cancelled exactly once`, async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const submission = deferred(), cancellation = deferred();
  let submitSignal;
  const { comfy, calls } = localMock({
    submit: (_workflow, { signal }) => { submitSignal = signal; return submission.promise; },
    cancel: (id, options) => { calls.cancel.push({ id, ...options }); return cancellation.promise; },
  });
  let failure;
  const pending = run(comfy, { timeoutSeconds: 30, signal: controller.signal }).catch((error) => { failure = error; });
  if (reason === "timeout") await time.tick(30000);
  else { await flush(); controller.abort(); }
  await pending;
  assert.equal(failure.code, reason === "timeout" ? "local_prompt_timeout" : "cancelled");
  assert.equal(submitSignal.aborted, true);
  assert.equal(calls.cancel.length, 0);
  assert.ok(failure.cleanup instanceof Promise);
  submission.resolve({ promptId: "late-id" });
  await flush();
  controller.abort();
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["late-id"]);
  let clean = false;
  failure.cleanup.then(() => { clean = true; });
  await flush();
  assert.equal(clean, false);
  cancellation.resolve();
  await failure.cleanup;
  assert.equal(calls.history.length + calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
});

test("submit acknowledgement racing with abort awaits one cancellation", async (t) => {
  const time = clock(t);
  const controller = new AbortController();
  const { comfy, calls } = localMock({ submit: async () => { controller.abort(); return { promptId: "racing-id" }; } });
  let failure;
  await run(comfy, { signal: controller.signal }).catch((error) => { failure = error; });
  await failure.cleanup;
  assert.equal(failure.code, "cancelled");
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["racing-id"]);
  assert.equal(calls.history.length + calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
});

test("late cancellation failure is explicitly logged and observable, never an unhandled rejection", async (t) => {
  const time = clock(t);
  const submission = deferred();
  const logs = [];
  const { comfy, calls } = localMock({ submit: () => submission.promise, cancel: async (id) => { calls.cancel.push({ id }); throw new Error("cannot cancel late ID"); } });
  let failure;
  const pending = run(comfy, { timeoutSeconds: 30, logger: { error: (message) => logs.push(message) } }).catch((error) => { failure = error; });
  await time.tick(30000);
  await pending;
  const cleaned = assert.rejects(failure.cleanup, { code: "local_cancel_failed" });
  submission.resolve({ promptId: "late-failed" });
  await cleaned;
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["late-failed"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /local_cancel_failed.*late-failed/);
  assert.equal(time.timers.size, 0);
});

test("unknown timed-out submission can reject late without unhandled rejection or global interrupt", async (t) => {
  const time = clock(t);
  const submission = deferred();
  const { comfy, calls } = localMock({ submit: () => submission.promise });
  let failure;
  const pending = run(comfy, { timeoutSeconds: 30 }).catch((error) => { failure = error; });
  await time.tick(30000);
  await pending;
  submission.reject(new Error("late network error"));
  await failure.cleanup;
  assert.equal(calls.cancel.length + calls.interrupt.length, 0);
});

test("legacy interrupt fallback always receives the original nonempty prompt ID", async (t) => {
  const time = clock(t);
  const { comfy, calls } = localMock({ cancel: undefined, history: () => new Promise(() => {}) });
  const pending = assert.rejects(run(comfy, { timeoutSeconds: 30 }), { code: "local_prompt_timeout" });
  await time.tick(30000);
  await pending;
  assert.deepEqual(calls.interrupt.map(({ id }) => id), ["local-id"]);
});

test("missing prompt ID never calls cancel or global interrupt", async () => {
  const { comfy, calls } = localMock({ submit: async () => ({}) });
  await assert.rejects(run(comfy), { code: "no_prompt_id" });
  assert.equal(calls.cancel.length + calls.interrupt.length + calls.history.length, 0);
});

test("partial TE output and output-node text cannot complete a running history", async (t) => {
  const time = clock(t);
  let polls = 0, settled = false;
  const { comfy, calls } = localMock({ history: async () => {
    polls++;
    return polls < 3 ? { status: { completed: false, status_str: "running" }, outputs: { "2": { text: ["Intermediate TE template"] }, "4": { text: ["Not terminal"] } } } : success();
  } });
  const pending = run(comfy).then((result) => { settled = true; return result; });
  await time.tick(1000);
  assert.equal(polls, 2);
  assert.equal(settled, false);
  await time.tick(1000);
  assert.deepEqual((await pending).history, success());
  assert.equal(calls.cancel.length, 0);
  assert.equal(time.timers.size, 0);
});

test("execution_success event is terminal even without completed boolean", async () => {
  const history = { status: { messages: [["execution_success", { prompt_id: "local-id" }]] }, outputs: { "4": { text: ["猫"] } } };
  const { comfy } = localMock({ history: async () => history });
  assert.equal((await run(comfy)).history, history);
});

for (const status of [{ status_str: "error", messages: ["model failed"] }, { messages: [["execution_error", { message: "model failed" }]] }, { messages: [["execution_interrupted", {}]] }]) test(`terminal error ${JSON.stringify(status)} is not a successful partial output`, async () => {
  const { comfy, calls } = localMock({ history: async () => ({ status, outputs: { "2": { text: ["Intermediate"] } } }) });
  await assert.rejects(run(comfy), { code: "comfy_execution_failed" });
  assert.equal(calls.cancel.length, 0);
});

test("history transport failure awaits targeted cleanup without resubmitting generation", async (t) => {
  const time = clock(t);
  const cancelling = deferred();
  const failure = new Error("history connection lost");
  let settled = false;
  const { comfy, calls } = localMock({ history: async () => { throw failure; }, cancel: (id) => { calls.cancel.push({ id }); return cancelling.promise; } });
  const pending = assert.rejects(run(comfy), (error) => error === failure).then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["local-id"]);
  cancelling.resolve();
  await pending;
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.interrupt.length, 0);
  assert.equal(time.timers.size, 0);
});

test("history transport failure reports cleanup failure explicitly", async () => {
  const { comfy, calls } = localMock({ history: async () => { throw new Error("history failed"); }, cancel: async (id) => { calls.cancel.push({ id }); throw new Error("cancel failed"); } });
  await assert.rejects(run(comfy), { code: "local_cancel_failed", status: 502 });
  assert.deepEqual(calls.cancel.map(({ id }) => id), ["local-id"]);
  assert.equal(calls.submit.length, 1);
});

test("KVMem receives normalized timeout and owns its own deadline/cleanup", async (t) => {
  const time = clock(t);
  let received;
  const controller = new AbortController();
  const instance = optimizer(null, { localCaption: async (options) => { received = options; return { prompt: "<think>hidden</think>画面描述：一只猫", model: "kvmem-model" }; } });
  for (const [input, expected] of [[undefined, 600], ["900", 900], [1800, 1800]]) {
    const result = await instance.captionImage({ engine: "kvmem", localImages: ["data:image/png;base64,AAAA"], localTimeoutSeconds: input, signal: controller.signal });
    assert.equal(received.timeoutSeconds, expected);
    assert.equal(received.signal, controller.signal);
    assert.equal(result.prompt, "一只猫");
    assert.equal(result.engine, "kvmem");
  }
  assert.deepEqual(time.scheduled, [], "no outer Comfy deadline can preempt KVMem cleanup");
  await assert.rejects(instance.captionImage({ engine: "kvmem", localImages: ["data:image/png;base64,AAAA"], localTimeoutSeconds: "invalid" }), { code: "local_invalid_timeout" });
});

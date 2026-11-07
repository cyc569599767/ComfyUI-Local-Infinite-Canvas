import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverCompletedVideo } from "../src/video-recovery.js";

const VIDEO = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex");
const FILE = { filename: "clip.mp4", subfolder: "MiniMaxH3", type: "output" };

function fixture({ task = {}, history, viewed } = {}) {
  const current = { id: "failed-video", status: "failed", promptId: "original-prompt", request: { interpolation: "off" }, ...task };
  const calls = [];
  const forbidden = (method) => async () => {
    calls.push([method]);
    throw new Error(`Recovery must never ${method}`);
  };
  const comfy = {
    history: async (...args) => {
      calls.push(["history", ...args]);
      return history === undefined ? { status: { completed: true, status_str: "success" }, outputs: { 42: { gifs: [FILE] } } } : history;
    },
    view: async (...args) => {
      calls.push(["view", ...args]);
      return viewed === undefined ? { buffer: VIDEO, contentType: "video/mp4" } : viewed;
    },
    submit: forbidden("submit"),
    cancel: forbidden("cancel"),
    interrupt: forbidden("interrupt"),
    uploadImage: forbidden("uploadImage"),
    freeMemory: forbidden("freeMemory"),
  };
  return { task: current, comfy, calls };
}

async function expectRejected(options, code, expectedCalls = []) {
  const { task, comfy, calls } = fixture(options);
  const before = structuredClone(task);
  await assert.rejects(recoverCompletedVideo({ task, comfy }), { code });
  assert.deepEqual(calls.map(([name]) => name), expectedCalls);
  assert.deepEqual(task, before);
}

test("recovers the unique completed output GIF entry containing an MP4 without resubmission", async () => {
  const { task, comfy, calls } = fixture();
  const before = structuredClone(task);
  const controller = new AbortController();
  const result = await recoverCompletedVideo({ task, comfy, signal: controller.signal });
  assert.deepEqual(result, { buffer: VIDEO, ext: "mp4", mimeType: "video/mp4", promptId: "original-prompt" });
  assert.deepEqual(calls, [["history", "original-prompt", { signal: controller.signal }], ["view", FILE, { signal: controller.signal }]]);
  assert.deepEqual(task, before);
});

test("all non-failed states, missing prompt IDs and interpolation are rejected before any Comfy call", async () => {
  for (const status of ["completed", "queued", "running", "cancelling", "cancelled", undefined]) {
    await expectRejected({ task: { status } }, "task_not_recoverable");
  }
  for (const promptId of [null, undefined, "", "   ", 123]) {
    await expectRejected({ task: { promptId } }, "recovery_missing_prompt_id");
  }
  for (const interpolation of ["2x", "3x", "unknown", false, ""]) {
    await expectRejected({ task: { request: { interpolation } } }, "recovery_interpolation_unsupported");
  }
});

test("history must confirm completion or success and must not contradict it with an error", async () => {
  for (const history of [
    null,
    {},
    { outputs: { 42: { gifs: [FILE] } } },
    { status: { completed: false, status_str: "running" } },
    { status: { completed: "true" } },
    { status: { completed: true, status_str: "error" } },
    { status: { completed: true, status_str: "failed" } },
    { status: { completed: true, status_str: "interrupted" } },
    { status: { completed: true, status_str: "success", error: "bad" } },
    { status: { completed: true, status_str: "success", messages: [["execution_error", { message: "bad" }]] } },
    { status: { completed: true, status_str: "success", messages: [["execution_interrupted", {}]] } },
    { status: { completed: true }, error: "bad" },
  ]) {
    await expectRejected({ history }, "recovery_history_not_successful", ["history"]);
  }
});

test("both completed-only and success-only histories are accepted, with legacy missing interpolation", async () => {
  for (const status of [{ completed: true }, { status_str: "success" }, { status_str: "success", completed: false }]) {
    const { task, comfy } = fixture({ task: { request: {} }, history: { status, outputs: { 42: { videos: [FILE] } } } });
    assert.equal((await recoverCompletedVideo({ task, comfy })).promptId, "original-prompt");
  }
});

test("deduplicates the same output across images/gifs/videos and ignores input/temp/nonvideo entries", async () => {
  const { task, comfy, calls } = fixture({ history: {
    status: { completed: true },
    outputs: {
      1: { images: [FILE, { ...FILE, type: "input" }, { ...FILE, filename: "poster.png" }] },
      2: { gifs: [{ ...FILE, ignored: true }, { ...FILE, type: "temp" }] },
      3: { videos: [{ ...FILE }, { ...FILE, type: undefined }] },
      4: { gifs: "not-an-array", other: [{ ...FILE, filename: "ignored.webm" }] },
    },
  } });
  assert.equal((await recoverCompletedVideo({ task, comfy })).ext, "mp4");
  assert.deepEqual(calls.map(([name]) => name), ["history", "view"]);
  assert.deepEqual(calls[1][1], FILE);
  assert.ok(calls[0][2].signal instanceof AbortSignal);
  assert.equal(calls[1][2].signal, calls[0][2].signal);
});

test("different output files or same basenames in different subfolders are ambiguous", async () => {
  for (const other of [{ ...FILE, filename: "second.mp4" }, { ...FILE, subfolder: "other" }]) {
    await expectRejected({ history: { status: { completed: true }, outputs: { 1: { gifs: [FILE] }, 2: { videos: [other] } } } }, "recovery_ambiguous_video", ["history"]);
  }
});

test("missing, malformed, preview and nonvideo outputs do not qualify", async () => {
  for (const outputs of [undefined, {}, { 1: { images: [{ ...FILE, filename: "preview.png" }] } }, { 1: { gifs: [{ ...FILE, type: "temp" }] } }, { 1: { gifs: [null, {}, { ...FILE, filename: null }, { ...FILE, subfolder: {} }] } }]) {
    await expectRejected({ history: { status: { completed: true }, outputs } }, "recovery_video_not_found", ["history"]);
  }
});

test("supports all allowed extensions and derives MIME from octet-stream responses", async () => {
  for (const [ext, mimeType] of [["mp4", "video/mp4"], ["webm", "video/webm"], ["mov", "video/quicktime"], ["mkv", "video/x-matroska"]]) {
    const { task, comfy } = fixture({
      history: { status: { completed: true }, outputs: { 1: { videos: [{ filename: `clip.${ext.toUpperCase()}`, type: "output" }] } } },
      viewed: { buffer: VIDEO, contentType: "application/octet-stream; charset=binary" },
    });
    assert.deepEqual(await recoverCompletedVideo({ task, comfy }), { buffer: VIDEO, ext, mimeType, promptId: "original-prompt" });
  }
});

test("rejects empty/nonbuffer bodies, image MIME/signatures and text/error bodies even if mislabeled", async () => {
  const bodies = [
    { buffer: Buffer.alloc(0), contentType: "video/mp4" },
    { buffer: "not-a-buffer", contentType: "video/mp4" },
    { buffer: VIDEO, contentType: "image/png" },
    { buffer: VIDEO, contentType: "text/html" },
    { buffer: VIDEO, contentType: "application/json" },
    { buffer: Buffer.from("89504e470d0a1a0a00000000", "hex"), contentType: "video/mp4" },
    { buffer: Buffer.from("ffd8ffe000010203", "hex"), contentType: "application/octet-stream" },
    { buffer: Buffer.from("GIF89a"), contentType: "video/mp4" },
    { buffer: Buffer.from("RIFF\0\0\0\0WEBP"), contentType: "video/mp4" },
    { buffer: Buffer.from("00000018667479706176696600000000", "hex"), contentType: "video/mp4" },
    { buffer: Buffer.from('{"error":"missing"}'), contentType: "video/mp4" },
    { buffer: Buffer.from("  <!doctype html><p>bad gateway</p>"), contentType: "application/octet-stream" },
    { buffer: Buffer.from("Error: output unavailable\n"), contentType: "video/mp4" },
    { buffer: Buffer.from("terminated"), contentType: "video/mp4" },
    null,
  ];
  for (const viewed of bodies) await expectRejected({ viewed }, "recovery_invalid_video", ["history", "view"]);
});

test("MP4 box sizes 256/512 are not misidentified as ICO/CUR image signatures", async () => {
  for (const size of [256, 512]) {
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32BE(size);
    buffer.write("ftyp", 4);
    buffer.write("isom", 8);
    const { task, comfy } = fixture({ viewed: { buffer, contentType: "video/mp4" } });
    assert.equal((await recoverCompletedVideo({ task, comfy })).buffer, buffer);
  }
});

test("history/view failures propagate without mutation, retries, cancellation or submissions", async () => {
  for (const method of ["history", "view"]) {
    const { task, comfy, calls } = fixture();
    const before = structuredClone(task);
    const error = new Error(`${method} failed`);
    comfy[method] = async () => { calls.push([method]); throw error; };
    await assert.rejects(recoverCompletedVideo({ task, comfy }), (actual) => actual === error);
    assert.deepEqual(task, before);
    assert.deepEqual(calls.map(([name]) => name), method === "history" ? ["history"] : ["history", "view"]);
  }
});

test("abort before history, after history and after view never returns a recovery result", async () => {
  for (const stage of ["before", "history", "view"]) {
    const { task, comfy, calls } = fixture();
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    else {
      const original = comfy[stage];
      comfy[stage] = async (...args) => { const result = await original(...args); controller.abort(); return result; };
    }
    await assert.rejects(recoverCompletedVideo({ task, comfy, signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(calls.map(([name]) => name), stage === "before" ? [] : stage === "history" ? ["history"] : ["history", "view"]);
  }
});

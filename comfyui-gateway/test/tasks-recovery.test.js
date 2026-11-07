import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskStore } from "../src/tasks.js";

const VIDEO = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex");
const RESULT = { buffer: VIDEO, ext: "mp4", mimeType: "video/mp4", promptId: "original-prompt" };

async function fixture(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-tasks-recovery-"));
  const store = createTaskStore({ dataDir });
  const task = store.create({ model: "fake-video", request: { interpolation: "off" } });
  Object.assign(task, { status: "failed", progress: 0.65, error: "terminated", promptId: "original-prompt", completedAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" });
  await store.persistNow();
  t.after(async () => {
    await store.persistNow();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, task };
}

async function persisted(dataDir) {
  return JSON.parse(await fsp.readFile(path.join(dataDir, "tasks.json"), "utf8")).tasks;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pauseRecoveryWrite(t) {
  const started = deferred();
  const release = deferred();
  const original = fsp.writeFile;
  let writes = 0;
  t.mock.method(fsp, "writeFile", async (file, ...args) => {
    if (path.basename(String(file)).includes("-recovered-")) {
      writes += 1;
      started.resolve();
      await release.promise;
    }
    return original(file, ...args);
  });
  return { started: started.promise, release: release.resolve, writes: () => writes };
}

test("recoverCompleted persists the saved failed task and preserves optional history completion time", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const createdAt = task.createdAt;
  const completedAt = "2026-11-06T17:23:45.678Z";
  const other = store.create({ model: "queued-test" });
  other._run = () => assert.fail("recovery must not run the queue");
  const otherBefore = store.publicTask(other);
  const result = await store.recoverCompleted(task.id, { ...RESULT, completedAt });
  assert.deepEqual(result, store.publicTask(task));
  assert.equal(result.status, "completed");
  assert.equal(result.progress, 1);
  assert.equal(result.promptId, "original-prompt");
  assert.equal(result.bytes, VIDEO.length);
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(result.error, null);
  assert.equal(result.completedAt, completedAt);
  assert.equal(result.createdAt, createdAt);
  assert.notEqual(result.updatedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(path.dirname(result.file), path.join(dataDir, "outputs"));
  assert.equal(result.url, `/files/${encodeURIComponent(path.basename(result.file))}`);
  assert.equal(store.contentPath(task.id), result.file);
  assert.deepEqual(await fsp.readFile(result.file), VIDEO);
  assert.deepEqual((await persisted(dataDir)).find((item) => item.id === task.id), result);
  assert.deepEqual(store.publicTask(other), otherBefore);
  assert.equal(typeof other._run, "function");
  const reloaded = createTaskStore({ dataDir });
  await reloaded.load();
  assert.deepEqual(reloaded.publicTask(reloaded.get(task.id)), result);
});

test("recoverCompleted defaults completion time to recovery time, not the old failure timestamp", async (t) => {
  const { store, task } = await fixture(t);
  const result = await store.recoverCompleted(task.id, RESULT);
  assert.equal(result.completedAt, result.updatedAt);
  assert.notEqual(result.completedAt, "2020-01-01T00:00:00.000Z");
});

test("completed recovery is idempotent and never rewrites the file even with an invalid second result", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const first = await store.recoverCompleted(task.id, RESULT);
  const second = await store.recoverCompleted(task.id, null);
  assert.deepEqual(second, first);
  assert.equal((await fsp.readdir(path.join(dataDir, "outputs"))).length, 1);
  assert.deepEqual(await fsp.readFile(first.file), VIDEO);
});

test("missing and non-failed tasks are rejected without mutation or output writes", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  await assert.rejects(store.recoverCompleted("missing-task", RESULT), { status: 404, code: "task_not_found" });
  for (const status of ["queued", "running", "cancelling", "cancelled", undefined]) {
    task.status = status;
    const before = store.publicTask(task);
    await assert.rejects(store.recoverCompleted(task.id, RESULT), { status: 409, code: "task_not_recoverable" });
    assert.deepEqual(store.publicTask(task), before);
  }
  assert.deepEqual(await fsp.readdir(path.join(dataDir, "outputs")), []);
});

test("invalid buffers, prompt mismatch and invalid completion times never alter the failed task", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const before = store.publicTask(task);
  for (const [result, code] of [
    [null, "recovery_invalid_video"],
    [{ ...RESULT, buffer: Buffer.alloc(0) }, "recovery_invalid_video"],
    [{ ...RESULT, buffer: "text" }, "recovery_invalid_video"],
    [{ ...RESULT, promptId: "another-prompt" }, "recovery_prompt_mismatch"],
    [{ ...RESULT, completedAt: "yesterday" }, "recovery_invalid_completed_at"],
    [{ ...RESULT, completedAt: 1700000000000 }, "recovery_invalid_completed_at"],
  ]) {
    await assert.rejects(store.recoverCompleted(task.id, result), { code });
    assert.deepEqual(store.publicTask(task), before);
  }
  assert.deepEqual(await fsp.readdir(path.join(dataDir, "outputs")), []);
});

test("saveOutput failure leaves failed status/error unchanged and a later recovery can succeed", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const before = store.publicTask(task);
  const original = fsp.writeFile;
  const mocked = t.mock.method(fsp, "writeFile", async (file, ...args) => {
    if (path.basename(String(file)).includes("-recovered-")) throw Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
    return original(file, ...args);
  });
  await assert.rejects(store.recoverCompleted(task.id, RESULT), { code: "ENOSPC" });
  assert.deepEqual(store.publicTask(task), before);
  assert.deepEqual((await persisted(dataDir)).find((item) => item.id === task.id), before);
  mocked.mock.restore();
  assert.equal((await store.recoverCompleted(task.id, RESULT)).status, "completed");
});

test("same-task concurrent recovery shares one save and returns the same committed result", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const write = pauseRecoveryWrite(t);
  const first = store.recoverCompleted(task.id, RESULT);
  await write.started;
  assert.equal(task.status, "failed");
  const second = store.recoverCompleted(task.id, { ...RESULT, buffer: Buffer.from("different") });
  write.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(write.writes(), 1);
  assert.deepEqual(await fsp.readFile(task.file), VIDEO);
  assert.equal((await fsp.readdir(path.join(dataDir, "outputs"))).length, 1);
});

test("status change during save prevents commit and removes only the new recovery output", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const write = pauseRecoveryWrite(t);
  const recovery = store.recoverCompleted(task.id, RESULT);
  await write.started;
  Object.assign(task, { status: "cancelled", error: "external cancellation" });
  const changed = store.publicTask(task);
  const rejected = assert.rejects(recovery, { code: "recovery_state_changed" });
  write.release();
  await rejected;
  assert.deepEqual(store.publicTask(task), changed);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, "outputs")), []);
});

test("concurrent completed state is returned without overwriting its output", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const write = pauseRecoveryWrite(t);
  const recovery = store.recoverCompleted(task.id, RESULT);
  await write.started;
  const winnerBytes = Buffer.from("winner output");
  const winner = await store.saveOutput(task.id, winnerBytes, "mp4");
  Object.assign(task, winner, { status: "completed", progress: 1, error: null, bytes: winnerBytes.length });
  const expected = store.publicTask(task);
  write.release();
  assert.deepEqual(await recovery, expected);
  assert.deepEqual(await fsp.readFile(winner.file), winnerBytes);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, "outputs")), [path.basename(winner.file)]);
});

test("task removal during save cannot resurrect the record or leave the recovery output", async (t) => {
  const { dataDir, store, task } = await fixture(t);
  const write = pauseRecoveryWrite(t);
  const recovery = store.recoverCompleted(task.id, RESULT);
  await write.started;
  const cleaned = await store.cleanup({ retentionDays: 1 });
  assert.equal(cleaned.removed, 1);
  const rejected = assert.rejects(recovery, { code: "recovery_state_changed" });
  write.release();
  await rejected;
  assert.equal(store.get(task.id), null);
  assert.deepEqual(await persisted(dataDir), []);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, "outputs")), []);
});

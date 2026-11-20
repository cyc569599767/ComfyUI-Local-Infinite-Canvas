import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskStore } from "../src/tasks.js";

async function fixture(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-tasks-test-"));
  const store = createTaskStore({ dataDir, publicBaseUrl: "http://127.0.0.1:8190" });
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for task state");
}

async function waitForPersistedStatus(dataDir, id, status, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const persisted = JSON.parse(await fsp.readFile(path.join(dataDir, "tasks.json"), "utf8"));
      if (persisted.tasks.find((task) => task.id === id)?.status === status) return;
    } catch {
      // The previous atomic snapshot may not include the terminal state yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for persisted status ${status}`);
}

function cancelledError() {
  return Object.assign(new Error("aborted"), { code: "cancelled" });
}

test("Chinese semantic output names preserve content and never overwrite duplicate IDs", async t => {
  const {dataDir,store}=await fixture(t);
  const first=await store.saveOutput("task-1",Buffer.from("old"),"png","陆明/蓝衣:%date%");
  const second=await store.saveOutput("task-1",Buffer.from("new"),"png","陆明/蓝衣:%date%");
  assert.equal(path.dirname(first.file),path.join(dataDir,"outputs"));
  assert.match(path.basename(first.file),/^陆明_蓝衣__date__task-1\.png$/);
  assert.notEqual(first.file,second.file);
  assert.equal(await fsp.readFile(first.file,"utf8"),"old");
  assert.equal(await fsp.readFile(second.file,"utf8"),"new");
  assert.equal(decodeURIComponent(first.url.split('/').at(-1)),path.basename(first.file));
  const plain=await store.saveOutput("legacy-id",Buffer.from("plain"),"mp4");
  assert.equal(path.basename(plain.file),"legacy-id.mp4");
});

test("video task persists semantic name without changing task identity", async t=>{
 const {dataDir,store}=await fixture(t);const task=store.create({model:"test"});const id=task.id;
 store.enqueue(task,async()=>({buffer:Buffer.from("video"),ext:"mp4",assetName:"灯塔重逢-视频"}));
 await waitFor(()=>task.status==="completed");
 await waitForPersistedStatus(dataDir,id,"completed");
 assert.equal(task.id,id);assert.ok(decodeURIComponent(task.url).includes("灯塔重逢-视频_"));
});

test("cancelling a queued task releases its run handles and persists immediately", async (t) => {
  const { dataDir, store } = await fixture(t);
  const blocker = store.create({ model: "test" });
  let releaseBlocker;
  store.enqueue(blocker, () => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));
  const queued = store.create({ model: "test" });
  let queuedRuns = 0;
  store.enqueue(queued, async () => {
    queuedRuns += 1;
  });
  assert.equal(typeof queued._run, "function");

  const result = await store.cancel(queued.id);
  assert.equal(result.status, "cancelled");
  assert.equal(queued._run, undefined);
  assert.equal(queued._controller, undefined);
  assert.equal(queuedRuns, 0);
  const persisted = JSON.parse(await fsp.readFile(path.join(dataDir, "tasks.json"), "utf8"));
  assert.equal(persisted.tasks.find((task) => task.id === queued.id).status, "cancelled");

  releaseBlocker({ buffer: Buffer.from("video"), ext: "mp4" });
  await waitFor(() => blocker.status === "completed");
});

test("cancelling a running task exposes cancelling until the run settles", async (t) => {
  const { dataDir, store } = await fixture(t);
  const task = store.create({ model: "test" });
  store.enqueue(task, (current, onProgress, signal) => {
    onProgress({ promptId: "prompt-running" });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
    });
  });
  let releaseCancel;
  const pending = store.cancel(task.id, {
    cancel: () => new Promise((resolve) => {
      releaseCancel = resolve;
    }),
  });
  assert.equal(task.status, "cancelling");
  releaseCancel();
  await pending;
  await waitFor(() => task.status === "cancelled");
  await waitForPersistedStatus(dataDir, task.id, "cancelled");
  assert.equal(task.error, "aborted");
});

test("a downstream cancellation failure becomes failed instead of false cancelled", async (t) => {
  const { dataDir, store } = await fixture(t);
  const task = store.create({ model: "test" });
  store.enqueue(task, (current, onProgress, signal) => {
    onProgress({ promptId: "prompt-failure" });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
    });
  });

  await assert.rejects(
    store.cancel(task.id, {
      cancel: async () => {
        throw new Error("injected downstream failure");
      },
    }),
    /injected downstream failure/,
  );
  await waitForPersistedStatus(dataDir, task.id, "failed");
  assert.equal(task.status, "failed");
  assert.match(task.error, /任务取消失败.*injected downstream failure/);
  const persisted = JSON.parse(await fsp.readFile(path.join(dataDir, "tasks.json"), "utf8"));
  assert.equal(persisted.tasks.find((item) => item.id === task.id).status, "failed");
});

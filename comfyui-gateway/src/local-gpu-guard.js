import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function failure(message, code = "local_gpu_busy", status = 409) {
  return Object.assign(new Error(message), { code, status });
}

// Serializes admission, not inference: acknowledged Comfy prompts remain visible
// in /queue. The reservation spans queue inspection, /free, worker and cleanup.
// Clients bypassing this gateway are explicitly outside this process-local lock.
export function createLocalGpuAdmission() {
  let owner = null;
  let submissions = 0;
  let uncertainSubmission = false;
  let reconcile = () => {};
  return {
    setReconcile(callback) { reconcile = callback; },
    beginComfySubmission() {
      reconcile();
      if (owner) throw failure("KVMem 正在反推或释放显存，请等待完成后再提交生成任务。");
      submissions++;
      let released = false;
      return ({ uncertain = false } = {}) => {
        if (!released) { released = true; submissions--; uncertainSubmission ||= uncertain; }
      };
    },
    reserve() {
      reconcile();
      if (uncertainSubmission) throw failure("此前生成提交结果未确认，为避免迟到任务与反推争用显存，已暂停 KVMem。请确认 ComfyUI 任务结束并重启桌面网关。", "local_gpu_submission_unknown");
      if (owner || submissions) throw failure("本地 GPU 正忙，请等待生成提交或反推任务结束后重试。");
      const token = Symbol("kvmem-caption");
      owner = token;
      return () => { if (owner === token) owner = null; };
    },
    busy: () => owner !== null,
  };
}

function assertIdle(queue, tasks = []) {
  if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) {
    throw failure("无法确认 ComfyUI 队列状态；为避免显存冲突，未启动 KVMem。", "local_gpu_queue_unknown", 503);
  }
  if (queue.queue_running.length || queue.queue_pending.length || tasks.some(task => ["queued", "running", "cancelling"].includes(task.status))) {
    throw failure("ComfyUI 有正在执行或排队的生成任务，请完成后再使用本地反推。");
  }
}

export function createGuardedCaption({ admission, comfy, runtime, config, pendingTasks = () => [], sleep = delay, now = Date.now, settleTimeoutMs = 15000 }) {
  let retainedRelease = null;
  admission.setReconcile(() => {
    if (retainedRelease && !runtime.isBusy()) { retainedRelease(); retainedRelease = null; }
  });
  async function run(params) {
    params.signal?.throwIfAborted();
    const capability = runtime.capability();
    if (!capability.available) throw failure(capability.reasons.join("；"), "kvmem_not_configured", 400);
    const release = admission.reserve();
    try {
      assertIdle(await comfy.queue(), pendingTasks());
      params.signal?.throwIfAborted();
      // This only unloads idle Comfy models; it never stops its process or cancels
      // someone else's task. Physical release is checked before loading NInfer.
      await comfy.freeMemory();
      const deadline = now() + settleTimeoutMs;
      const required = fs.statSync(config.modelPath).size + 1024 ** 3;
      while (true) {
        params.signal?.throwIfAborted();
        assertIdle(await comfy.queue(), pendingTasks());
        const stats = await comfy.systemStats();
        const device = stats?.devices?.find(d => d.type === "cuda" && Number(d.index) === Number(config.gpuDevice));
        const available = Number(device?.vram_free) - Number(device?.torch_vram_free);
        // Comfy's vram_free includes allocator-reclaimable cache; an external
        // process needs the driver-free amount, not that optimistic total.
        if (device && Number.isFinite(available) && available >= required) break;
        if (now() >= deadline) throw failure("ComfyUI 缓存已请求卸载，但未确认足够空闲显存。请关闭其他占用显存的程序后重试；未启动 KVMem。", "kvmem_insufficient_vram", 409);
        await sleep(250, undefined, { signal: params.signal });
      }
      return await runtime.caption(params);
    } finally {
      if (runtime.isBusy()) retainedRelease = release;
      else release();
    }
  }
  async function close() {
    await runtime.close();
    if (!runtime.isBusy()) { retainedRelease?.(); retainedRelease = null; }
  }
  return { run, close };
}

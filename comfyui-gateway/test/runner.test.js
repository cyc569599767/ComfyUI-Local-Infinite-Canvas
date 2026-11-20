import assert from "node:assert/strict";
import { test } from "node:test";

import { buildContext } from "../src/bindings.js";
import { runImage, runVideo, runWorkflow } from "../src/runner.js";

function entry() {
  return {
    name: "runner-test",
    type: "image",
    workflow: { 1: { class_type: "Test", inputs: {} } },
    bindings: {},
    defaults: {},
    presets: {},
  };
}

test("execution error prioritizes failed node and traceback instead of truncating behind cached events", async () => {
  const runEntry = entry();
  await assert.rejects(runWorkflow({entry:runEntry, context:buildContext({prompt:"x"}), comfy:{
    submit:async()=>({promptId:"failure-id"}),
    history:async()=>({status:{status_str:"error",messages:[
      ["execution_start",{prompt_id:"failure-id"}],
      ["execution_cached",{nodes:Array.from({length:1000},(_,i)=>String(i))}],
      ["execution_error",{node_id:"170:169",node_type:"KSampler",exception_type:"ValueError",exception_message:"too many values to unpack (expected 4)",prompt_id:"failure-id",traceback:['File "D:/ComfyUI/comfy/ldm/qwen_image21/model.py", line 427','B, C, H, W = x.shape']}],
    ]}}),
  }}), error => {
    assert.equal(error.code,"comfy_execution_failed");
    assert.match(error.message,/170:169.*KSampler/);
    assert.match(error.message,/too many values to unpack/);
    assert.match(error.message,/匹配整套/);
    assert.equal(error.message.includes("execution_cached"),false);
    return true;
  });
});

test("a selected main model replaces the workflow UNET file", async () => {
  let submitted = null;
  const runEntry = {
    name: "runner-main-model",
    type: "image",
    workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "default.safetensors" } } },
    bindings: {},
    defaults: {},
    presets: {},
    mainModelFile: "my_custom_model.safetensors",
  };
  await runWorkflow({
    entry: runEntry,
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submitted = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
  });
  assert.equal(submitted["1"].inputs.unet_name, "my_custom_model.safetensors");
});

test("model aliases rewrite loader inputs before submit", async () => {
  let submitted = null;
  const runEntry = {
    name: "runner-model-alias",
    type: "image",
    workflow: {
      1: { class_type: "UNETLoader", inputs: { unet_name: "missing_model.safetensors" } },
      2: { class_type: "CLIPLoader", inputs: { clip_name: "keep.safetensors" } },
    },
    bindings: {},
    defaults: {},
    presets: {},
  };
  await runWorkflow({
    entry: runEntry,
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submitted = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor: (classType, input, value) => (classType === "UNETLoader" && value === "missing_model.safetensors" ? "local_subdir/model.safetensors" : ""),
  });
  assert.equal(submitted["1"].inputs.unet_name, "local_subdir/model.safetensors");
  assert.equal(submitted["2"].inputs.clip_name, "keep.safetensors");
});

test("dynamically discovered loaders also receive model aliases", async () => {
  let submitted = null;
  const runEntry = {
    name: "runner-dynamic-alias",
    type: "image",
    workflow: {
      1: { class_type: "llama_cpp_model_loader", inputs: { model: "expected-model.gguf", mmproj: "expected-mmproj.gguf" } },
    },
    bindings: {},
    defaults: {},
    presets: {},
  };
  await runWorkflow({
    entry: runEntry,
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submitted = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor: (classType, input, value) => {
      if (classType !== "llama_cpp_model_loader") return "";
      if (input === "model" && value === "expected-model.gguf") return "local-model.gguf";
      if (input === "mmproj" && value === "expected-mmproj.gguf") return "local-mmproj.gguf";
      return "";
    },
    loaderSpecs: [
      { classType: "llama_cpp_model_loader", input: "model" },
      { classType: "llama_cpp_model_loader", input: "mmproj" },
    ],
  });
  assert.equal(submitted["1"].inputs.model, "local-model.gguf");
  assert.equal(submitted["1"].inputs.mmproj, "local-mmproj.gguf");
});

test("aborting a running workflow interrupts ComfyUI", async () => {
  const controller = new AbortController();
  let interrupted = null;
  const comfy = {
    submit: async () => ({ promptId: "prompt-1" }),
    history: async () => null,
    interrupt: async (promptId) => {
      interrupted = promptId;
    },
    view: async () => {
      throw new Error("should not download outputs");
    },
  };

  const running = runWorkflow({
    entry: entry(),
    context: buildContext({ prompt: "x" }),
    comfy,
    timeoutMs: 5000,
    pollIntervalMs: 10,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort("user-stop"), 30);

  await assert.rejects(running, (error) => error.code === "cancelled");
  assert.equal(interrupted, "prompt-1");
});

test("a normal polling timeout makes one best-effort downstream cancel", async () => {
  let cancelCalls = 0;
  const comfy = {
    submit: async () => ({ promptId: "prompt-timeout" }),
    history: async () => null,
    cancel: async () => {
      cancelCalls += 1;
    },
  };

  await assert.rejects(
    runWorkflow({ entry: entry(), context: buildContext({ prompt: "x" }), comfy, timeoutMs: 5, pollIntervalMs: 1 }),
    (error) => error.code === "generation_timeout",
  );
  assert.equal(cancelCalls, 1);
});

test("a timeout reports downstream cancellation failure diagnostically", async () => {
  const comfy = {
    submit: async () => ({ promptId: "prompt-timeout" }),
    history: async () => null,
    cancel: async () => {
      throw new Error("injected interrupt failure");
    },
  };

  await assert.rejects(
    runWorkflow({ entry: entry(), context: buildContext({ prompt: "x" }), comfy, timeoutMs: 5, pollIntervalMs: 1 }),
    (error) => error.code === "generation_cancel_failed" && error.status === 504 && error.details.cause.includes("injected interrupt failure"),
  );
});

test("aborting a stuck history request propagates its signal and awaits cancellation", async () => {
  const controller = new AbortController();
  let historySignal;
  let cancelCalls = 0;
  const comfy = {
    submit: async () => ({ promptId: "prompt-stuck" }),
    history: async (_promptId, { signal } = {}) => {
      historySignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("history aborted")), { once: true });
      });
    },
    cancel: async () => {
      cancelCalls += 1;
    },
  };

  const running = runWorkflow({
    entry: entry(),
    context: buildContext({ prompt: "x" }),
    comfy,
    timeoutMs: 5000,
    pollIntervalMs: 1,
    signal: controller.signal,
  });
  while (!historySignal) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort("user-stop");

  await assert.rejects(running, (error) => error.code === "cancelled");
  assert.equal(historySignal, controller.signal);
  assert.equal(cancelCalls, 1);
});

test("abort does not report cancelled when downstream cancellation fails", async () => {
  const controller = new AbortController();
  const comfy = {
    submit: async () => ({ promptId: "prompt-cancel-failure" }),
    history: async (_promptId, { signal } = {}) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("history aborted")), { once: true });
    }),
    cancel: async () => {
      throw new Error("injected cancel failure");
    },
  };

  const running = runWorkflow({
    entry: entry(),
    context: buildContext({ prompt: "x" }),
    comfy,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort("user-stop"), 10);
  await assert.rejects(running, (error) => error.code === "generation_cancel_failed" && error.details.cause.includes("injected cancel failure"));
});

test("a pre-aborted request is never submitted", async () => {
  const controller = new AbortController();
  controller.abort("user-stop");
  let submitted = 0;
  const comfy = {
    submit: async () => {
      submitted += 1;
      return { promptId: "prompt-1" };
    },
  };

  await assert.rejects(
    () =>
      runWorkflow({
        entry: entry(),
        context: buildContext({ prompt: "x" }),
        comfy,
        signal: controller.signal,
      }),
    (error) => error.code === "cancelled",
  );
  assert.equal(submitted, 0);
});

function loaderEntry() {
  return {
    name: "runner-base-model",
    type: "image",
    workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "default.safetensors" } } },
    bindings: { unet: { node: "1", input: "unet_name", from: "params.unet", default: "default.safetensors" } },
    defaults: {},
    presets: {},
  };
}

function fakeComfy(onSubmit) {
  return {
    submit: async (workflow) => {
      onSubmit?.(workflow);
      return { promptId: "prompt-base" };
    },
    history: async () => ({
      status: { status_str: "success" },
      outputs: { 9: { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
    }),
    view: async () => ({ buffer: Buffer.from([1, 2, 3]), contentType: "image/png" }),
  };
}

test("runImage and runVideo forward loaderSpecs to the workflow runner", async () => {
  const runEntry = () => ({
    name: "runner-loader-specs",
    type: "image",
    workflow: { 1: { class_type: "LoraLoaderBypassModelOnly", inputs: { lora_name: "expected.safetensors" } } },
    bindings: {},
    defaults: {},
    presets: {},
  });
  const modelAliasFor = (classType, input, value) => (classType === "LoraLoaderBypassModelOnly" && value === "expected.safetensors" ? "local.safetensors" : "");
  const loaderSpecs = [{ classType: "LoraLoaderBypassModelOnly", input: "lora_name" }];
  let imageWorkflow = null;
  await runImage({
    entry: runEntry(),
    context: buildContext({ prompt: "x", count: 1 }),
    comfy: fakeComfy((workflow) => {
      imageWorkflow = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor,
    loaderSpecs,
  });
  assert.equal(imageWorkflow["1"].inputs.lora_name, "local.safetensors");

  let videoWorkflow = null;
  const videoComfy = {
    submit: async (workflow) => {
      videoWorkflow = workflow;
      return { promptId: "prompt-video" };
    },
    history: async () => ({
      status: { status_str: "success" },
      outputs: { 9: { videos: [{ filename: "out.mp4", subfolder: "", type: "output" }] } },
    }),
    view: async () => ({ buffer: Buffer.from("video"), contentType: "video/mp4" }),
  };
  await runVideo({
    entry: { ...runEntry(), type: "video" },
    context: buildContext({ prompt: "x" }),
    comfy: videoComfy,
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor,
    loaderSpecs,
  });
  assert.equal(videoWorkflow["1"].inputs.lora_name, "local.safetensors");
});

test("base model variants apply params.unet without touching request params", async () => {
  let submittedWorkflow;
  await runWorkflow({
    entry: { ...loaderEntry(), baseModelParams: { unet: "variant.safetensors" } },
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submittedWorkflow = workflow;
    }),
    pollIntervalMs: 10,
  });
  assert.equal(submittedWorkflow[1].inputs.unet_name, "variant.safetensors");
});

test("explicit request params override the selected base model", async () => {
  let submittedWorkflow;
  await runWorkflow({
    entry: { ...loaderEntry(), baseModelParams: { unet: "variant.safetensors" } },
    context: buildContext({ prompt: "x", params: { unet: "request.safetensors" } }),
    comfy: fakeComfy((workflow) => {
      submittedWorkflow = workflow;
    }),
    pollIntervalMs: 10,
  });
  assert.equal(submittedWorkflow[1].inputs.unet_name, "request.safetensors");
});

// ── 视频生成完成后取回失败：不能丢掉已完成的产出线索（task_33b4d0aa） ──

test("history 已完成但 view 失败时，错误里带上 promptId 与文件名", async () => {
  const comfy = {
    submit: async () => ({ promptId: "prompt-done" }),
    history: async () => ({
      status: { status_str: "success" },
      outputs: { 12: { gifs: [{ filename: "czx_00001.mp4", subfolder: "MiniMaxH3", type: "output" }] } },
    }),
    view: async () => {
      throw Object.assign(new Error("无法连接 ComfyUI：terminated"), { code: "comfy_unreachable" });
    },
  };
  const events = [];
  await assert.rejects(
    runVideo({
      entry: { name: "v", type: "video", workflow: { 1: { class_type: "Test", inputs: {} } }, bindings: {}, defaults: {}, presets: {} },
      context: buildContext({ prompt: "x" }),
      comfy,
      timeoutMs: 5000,
      pollIntervalMs: 10,
      onProgress: (event) => events.push(event),
    }),
    (error) => {
      // 视频确实生成了，只是没取回来。必须明确告诉用户「已生成」，
      // 否则他会以为白跑一遍而重新生成，白烧一次算力。
      assert.equal(error.code, "output_download_failed");
      assert.match(error.message, /已生成/);
      assert.equal(error.details.promptId, "prompt-done");
      assert.equal(error.details.filename, "czx_00001.mp4");
      assert.equal(error.details.subfolder, "MiniMaxH3");
      return true;
    },
  );
  // 到达 0.65 说明 history 判定完成——这正是本次故障里 progress 停住的位置。
  assert.ok(events.some((event) => event.progress === 0.65), "应上报过「ComfyUI 已完成」这个节点");
});

test("等待期间持续上报进度，画布不会一直停在 5%", async () => {
  let polls = 0;
  const comfy = {
    submit: async () => ({ promptId: "prompt-slow" }),
    history: async () => {
      polls += 1;
      if (polls < 6) return null; // 还在跑
      return {
        status: { status_str: "success" },
        outputs: { 1: { gifs: [{ filename: "a.mp4", subfolder: "", type: "output" }] } },
      };
    },
    view: async () => ({ buffer: Buffer.from([1]), contentType: "video/mp4" }),
  };
  const events = [];
  await runVideo({
    entry: { name: "v", type: "video", workflow: { 1: { class_type: "Test", inputs: {} } }, bindings: {}, defaults: {}, presets: {} },
    context: buildContext({ prompt: "x" }),
    comfy,
    timeoutMs: 60000,
    pollIntervalMs: 5,
    onProgress: (event) => events.push(event),
  });
  const running = events.filter((event) => event.phase === "running");
  assert.ok(running.length > 0, "轮询期间必须有 running 进度事件");
  assert.ok(running.every((event) => event.progress > 0.05 && event.progress < 0.65), "running 进度应落在 5% 与 65% 之间");
  // 进度必须单调不减，否则界面会来回跳。
  const values = events.map((event) => event.progress);
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index] >= values[index - 1], "进度不能倒退");
  }
});

test("轮询遇到瞬时断连时继续等待，不判整个生成失败", async () => {
  let calls = 0;
  const comfy = {
    submit: async () => ({ promptId: "prompt-flaky" }),
    history: async () => {
      calls += 1;
      if (calls <= 3) throw Object.assign(new Error("无法连接 ComfyUI：terminated"), { code: "comfy_unreachable" });
      return {
        status: { status_str: "success" },
        outputs: { 1: { gifs: [{ filename: "a.mp4", subfolder: "", type: "output" }] } },
      };
    },
    view: async () => ({ buffer: Buffer.from([1]), contentType: "video/mp4" }),
  };
  // 三次查询失败后恢复：任务应当成功，而不是因为一次抖动就报废。
  const result = await runVideo({
    entry: { name: "v", type: "video", workflow: { 1: { class_type: "Test", inputs: {} } }, bindings: {}, defaults: {}, presets: {} },
    context: buildContext({ prompt: "x" }),
    comfy,
    timeoutMs: 60000,
    pollIntervalMs: 5,
  });
  assert.equal(result.promptId, "prompt-flaky");
  assert.ok(calls >= 4);
});

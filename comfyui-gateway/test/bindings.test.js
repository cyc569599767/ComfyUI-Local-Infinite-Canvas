import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBindings, buildContext, secondsToFrames17 } from "../src/bindings.js";

test("MiniMax-H3 length snaps to the 17k+5 grid at 24fps", () => {
  assert.equal(secondsToFrames17(5, 24), 124);
  assert.equal(secondsToFrames17(10, 24), 243);
  assert.equal(secondsToFrames17(1, 24), 39);
});

test("asLink creates LoadImage nodes only when frame images exist", () => {
  const workflow = { 6: { class_type: "MiniMaxH3ImageToVideo", inputs: { prompt: "x" } } };
  const entry = {
    name: "video-h3-t2v",
    bindings: {
      image: { node: "6", input: "first_frame", from: "image", imageIndex: 0, asLink: true },
      image2: { node: "6", input: "last_frame", from: "image", imageIndex: 1, asLink: true },
    },
  };
  const withFrames = applyBindings(workflow, entry, buildContext({ prompt: "x", uploadedImages: [{ name: "a.png" }, { name: "b.png" }] }));
  assert.deepEqual(withFrames["6"].inputs.first_frame, ["9001", 0]);
  assert.deepEqual(withFrames["6"].inputs.last_frame, ["9002", 0]);
  assert.equal(withFrames["9001"].class_type, "LoadImage");
  assert.equal(withFrames["9002"].inputs.image, "b.png");

  const textOnly = applyBindings(workflow, entry, buildContext({ prompt: "x", uploadedImages: [] }));
  assert.equal(textOnly["6"].inputs.first_frame, undefined);
  assert.equal(textOnly["6"].inputs.last_frame, undefined);
});

test("snap16 aligns image dimensions before validation", () => {
  const workflow = { 7: { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } } };
  const entry = {
    name: "image-snap16",
    bindings: {
      width: { node: "7", input: "width", from: "size.width", transform: "snap16" },
      height: { node: "7", input: "height", from: "size.height", transform: "snap16" },
    },
  };
  const output = applyBindings(workflow, entry, buildContext({ size: "1000x1000" }));
  assert.equal(output["7"].inputs.width, 1008);
  assert.equal(output["7"].inputs.height, 1008);
});

test("custom params override seed, sampler and boolean inputs", () => {
  const workflow = {
    4: { class_type: "KSampler", inputs: { seed: 1, sampler_name: "euler", scheduler: "simple" } },
    32: { class_type: "ApplyVDNH3Advanced", inputs: { fast_kernels: true } },
  };
  const entry = {
    name: "param-test",
    bindings: {
      seed: { node: "4", input: "seed", from: "params.seed", transform: "int", random: true },
      sampler: { node: "4", input: "sampler_name", from: "params.sampler", default: "euler" },
      scheduler: { node: "4", input: "scheduler", from: "params.scheduler", default: "simple" },
      fast_kernels: { node: "32", input: "fast_kernels", from: "params.fast_kernels", default: true, transform: "boolean" },
    },
  };
  const custom = applyBindings(
    workflow,
    entry,
    buildContext({ params: { seed: "42", sampler: "dpmpp_2m", scheduler: "karras", fast_kernels: false } }),
  );
  assert.equal(custom["4"].inputs.seed, 42);
  assert.equal(custom["4"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(custom["4"].inputs.scheduler, "karras");
  assert.equal(custom["32"].inputs.fast_kernels, false);

  const defaults = applyBindings(workflow, entry, buildContext({}));
  assert.ok(defaults["4"].inputs.seed > 0);
  assert.equal(defaults["4"].inputs.sampler_name, "euler");
  assert.equal(defaults["4"].inputs.scheduler, "simple");
  assert.equal(defaults["32"].inputs.fast_kernels, true);
});

test("H3 size snaps to multiples of 32 and reference images map by index", () => {
  const workflow = {
    136: {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        prompt: ["138", 0],
        width: ["115", 0],
        height: ["115", 1],
        length: ["131", 1],
        "ref_images.ref_image_0": ["137", 0],
        "ref_images.ref_image_1": ["139", 0],
      },
    },
  };
  const entry = {
    name: "video-h3-ref2va",
    bindings: {
      prompt: { node: "136", input: "prompt" },
      width: { node: "136", input: "width", from: "size.width", transform: "snap32" },
      height: { node: "136", input: "height", from: "size.height", transform: "snap32" },
      length: { node: "136", input: "length", from: "seconds", transform: "secondsToFrames17", fps: 24 },
      image: { node: "136", input: "ref_images.ref_image_0", from: "image", imageIndex: 0 },
      image2: { node: "136", input: "ref_images.ref_image_1", from: "image", imageIndex: 1 },
      image3: { node: "136", input: "ref_images.ref_image_2", from: "image", imageIndex: 2 },
    },
  };
  const context = buildContext({
    prompt: "a cat walking",
    size: "1280x720",
    seconds: "5",
    count: 1,
    uploadedImages: [{ name: "a.png" }, { name: "b.png" }, { name: "c.png" }],
  });
  const output = applyBindings(workflow, entry, context);
  assert.equal(output["136"].inputs.prompt, "a cat walking");
  assert.equal(output["136"].inputs.width, 1280);
  assert.equal(output["136"].inputs.height, 736);
  assert.equal(output["136"].inputs.length, 124);
  assert.equal(output["136"].inputs["ref_images.ref_image_0"], "a.png");
  assert.equal(output["136"].inputs["ref_images.ref_image_1"], "b.png");
  // 第三张参考图在原工作流里是可选输入，绑定时应能动态补上。
  assert.equal(output["136"].inputs["ref_images.ref_image_2"], "c.png");
});

// H3 角色替换：额度 6 图 / 1 源视频 / 2 音频，超限必须拒绝而不是静默截断。
// 静默截断会让用户以为第 7 张角色参考也参与了换人，出片后才发现换错了人。
const swapWorkflow = () => ({
  76: { class_type: "MiniMaxH3Ref2VA", inputs: { prompt: "x", width: 1344, height: 768, task_type: "Ref2VA" } },
});
const swapEntry = (extra = {}) => ({
  name: "video-h3-character-swap",
  strictMedia: true,
  bindings: {
    prompt: { node: "76", input: "prompt" },
    refs: { node: "76", input: "ref_images", from: "image", array: true, inputPrefix: "ref_images.ref_image_", min: 1, max: 6 },
    videos: { node: "76", input: "ref_videos", from: "video", array: true, inputPrefix: "ref_videos.ref_video_", min: 1, max: 1, loadType: "video", loader: "native" },
    audios: { node: "76", input: "ref_audios", from: "audio", array: true, inputPrefix: "ref_audios.ref_audio_", min: 0, max: 2, loadType: "audio" },
  },
  ...extra,
});
const images = (n) => Array.from({ length: n }, (_, i) => ({ name: `c${i}.png` }));
const videos = (n) => Array.from({ length: n }, (_, i) => ({ name: `v${i}.mp4` }));
const audios = (n) => Array.from({ length: n }, (_, i) => ({ name: `a${i}.wav` }));

test("character swap accepts 6 images + 1 video + 2 audios", () => {
  const out = applyBindings(
    swapWorkflow(),
    swapEntry(),
    buildContext({ prompt: "swap", uploadedImages: images(6), uploadedVideos: videos(1), uploadedAudios: audios(2) }),
  );
  const refKeys = Object.keys(out["76"].inputs).filter((key) => key.startsWith("ref_images."));
  const videoKeys = Object.keys(out["76"].inputs).filter((key) => key.startsWith("ref_videos."));
  const audioKeys = Object.keys(out["76"].inputs).filter((key) => key.startsWith("ref_audios."));
  assert.equal(refKeys.length, 6);
  assert.equal(videoKeys.length, 1);
  assert.equal(audioKeys.length, 2);
});

test("character swap rejects 7 images instead of silently dropping one", () => {
  assert.throws(
    () => applyBindings(swapWorkflow(), swapEntry(), buildContext({ prompt: "swap", uploadedImages: images(7), uploadedVideos: videos(1) })),
    (error) => error.code === "too_many_reference_media",
  );
});

test("character swap rejects 2 source videos", () => {
  assert.throws(
    () => applyBindings(swapWorkflow(), swapEntry(), buildContext({ prompt: "swap", uploadedImages: images(1), uploadedVideos: videos(2) })),
    (error) => error.code === "too_many_reference_media",
  );
});

test("character swap rejects 3 audios", () => {
  assert.throws(
    () => applyBindings(swapWorkflow(), swapEntry(), buildContext({ prompt: "swap", uploadedImages: images(1), uploadedVideos: videos(1), uploadedAudios: audios(3) })),
    (error) => error.code === "too_many_reference_media",
  );
});

test("character swap still requires at least one reference image", () => {
  assert.throws(
    () => applyBindings(swapWorkflow(), swapEntry(), buildContext({ prompt: "swap", uploadedImages: [], uploadedVideos: videos(1) })),
    (error) => error.code === "missing_reference_media",
  );
});

test("non-strict workflows keep truncating to their max", () => {
  // 没有 strictMedia 的工作流保持原行为：超限截断而不是报错。
  const out = applyBindings(
    swapWorkflow(),
    swapEntry({ strictMedia: false }),
    buildContext({ prompt: "swap", uploadedImages: images(9), uploadedVideos: videos(1) }),
  );
  assert.equal(Object.keys(out["76"].inputs).filter((key) => key.startsWith("ref_images.")).length, 6);
});

// ── 缺素材的报错必须能指导用户 ────────────────────────────────
//
// 现场：视频节点选「H3 角色替换」，画布上有图片卡但没拉线连过来，
// 用户只在提示词里写了「@image#1」。原报错是
// 「工作流需要至少 1 个参考素材，但请求里只有 0 个」——
// 完全看不出是「没连线」，用户无从下手。

test("缺角色参考图时，报错要说清是哪个绑定、缺几张、怎么补", () => {
  let caught = null;
  try {
    applyBindings(swapWorkflow(), swapEntry(), buildContext({ prompt: "swap", uploadedImages: [], uploadedVideos: videos(1) }));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "必须报错");
  assert.equal(caught.code, "missing_reference_media");
  // 指明绑定输入名
  assert.match(caught.message, /ref_images/);
  // 指明需要几张
  assert.match(caught.message, /至少 1 张/);
  // 指明素材类型
  assert.match(caught.message, /图片/);
  // 关键：告诉用户「要连线，光在提示词里写不算」
  assert.match(caught.message, /连接/);
  assert.match(caught.message, /@图1/);
  // details 带上结构化信息，前端可以做针对性引导
  assert.deepEqual(
    { need: caught.details?.need, got: caught.details?.got, kind: caught.details?.mediaKind },
    { need: 1, got: 0, kind: "图片" },
  );
});

test("缺视频素材时，报错要指明是视频而不是图片", () => {
  // 构造一个只需要视频的工作流场景：复用 swapEntry 但清空视频
  let caught = null;
  try {
    const entry = swapEntry({ bindings: { videos: { node: "76", input: "ref_videos", from: "video", array: true, inputPrefix: "ref_videos.ref_video_", min: 1, max: 1, loadType: "video" } } });
    applyBindings(swapWorkflow(), entry, buildContext({ prompt: "x", uploadedImages: [], uploadedVideos: [] }));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.match(caught.message, /视频/);
  assert.equal(caught.details?.mediaKind, "视频");
});

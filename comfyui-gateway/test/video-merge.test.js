import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MAX_MERGE_CLIPS, buildMergeArgs, createVideoMerger, normalizeMergeClips, parseMergeTimeline, resolveMergeSize, resolveTimelineSegments } from "../src/video-merge.js";

const info = (over = {}) => ({ width: 1280, height: 720, fps: 30, hasAudio: true, duration: 5, ...over });

test("normalizeMergeClips 把脏数据收敛成可用数字", () => {
  const clips = normalizeMergeClips([
    { inPoint: 1, outPoint: 3, duration: 5, start: 0, track: 0, volume: 1 },
    // 出点缺失：退回素材整段，而不是 0 帧空片段。
    { inPoint: 0, duration: 8, start: 8 },
    // 音量越界要夹回 0..2。
    { inPoint: 0, outPoint: 2, duration: 2, start: 16, volume: 9 },
  ]);
  assert.equal(clips[0].duration, 2);
  assert.equal(clips[1].outPoint, 8);
  assert.equal(clips[1].duration, 8);
  assert.equal(clips[2].volume, 2);
});

test("buildMergeArgs 统一缩放、补静音并 concat", () => {
  const clips = normalizeMergeClips([
    { inPoint: 0, outPoint: 2, duration: 2, start: 0, track: 0, volume: 0.5 },
    { inPoint: 0, outPoint: 3, duration: 3, start: 2, track: 0, volume: 1 },
  ]).map((clip, index) => ({ ...clip, file: `/tmp/c${index}.mp4` }));
  const infos = [info(), info({ hasAudio: false, width: 1920, height: 1080 })];
  const args = buildMergeArgs({ clips, infos, output: "/tmp/out.mp4", fps: 24 });
  const graph = args[args.indexOf("-filter_complex") + 1];
  // 成片尺寸取第一段素材，并且必须是偶数（libx264 的 yuv420p 要求）。
  assert.match(graph, /scale=1280:720:force_original_aspect_ratio=decrease/);
  assert.match(graph, /pad=1280:720/);
  // 有音轨的片段才谈得上音量；静音段补的是纯 anullsrc。
  assert.match(graph, /volume=0\.5/);
  // 第二段没有音轨，必须补等长静音，否则 concat 会按音频截断画面。
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=duration=3\.000/);
  assert.match(graph, /concat=n=2:v=1:a=1\[vout\]\[aout\]/);
  assert.match(graph, /fps=24/);
  // 输入顺序跟片段顺序一致，否则素材会串。
  const inputs = args.reduce((acc, value, index) => (value === "-i" ? [...acc, args[index + 1]] : acc), []);
  assert.deepEqual(inputs, ["/tmp/c0.mp4", "/tmp/c1.mp4"]);
  assert.equal(args.at(-1), "/tmp/out.mp4");
});

test("多轨使用同一全局时间轴，只在没有可见镜头时补黑场", () => {
  const clips = normalizeMergeClips([
    { inPoint: 0, outPoint: 2, start: 0, track: 0 },
    { inPoint: 0, outPoint: 1, start: 4, track: 0 },
    // 下层完全被遮挡，既不追加画面，也不混入其音频。
    { inPoint: 0, outPoint: 1, start: 0, track: 1 },
  ]).map((clip, index) => ({ ...clip, file: `/tmp/c${index}.mp4` }));
  const args = buildMergeArgs({ clips, infos: [info(), info(), info()], output: "/tmp/out.mp4" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /color=c=black:s=1280x720:r=30:d=2\.000/);
  assert.match(graph, /concat=n=3:v=1:a=1/);
  assert.equal((graph.match(/color=c=black/g) || []).length, 1);
  assert.equal(args.includes("/tmp/c2.mp4"), false);
  assert.equal(args[args.indexOf("-t") + 1], "5.000");
});

function plan(clips) {
  return resolveTimelineSegments(clips).map(({ start, duration, clip, inPoint }) =>
    clip ? { start, duration, index: clip.index, inPoint } : { start, duration });
}

test("可见计划按 track 升序优先，遮挡后按全局时间恢复素材偏移", () => {
  const clips = normalizeMergeClips([
    { start: 0, inPoint: 2, outPoint: 8, track: 2, layer: 100 },
    { start: 2, inPoint: 1, outPoint: 3, track: 0, layer: -1 },
    { start: 1, inPoint: 0, outPoint: 4, track: 3, layer: 999 },
  ]);
  assert.deepEqual(plan(clips), [
    { start: 0, duration: 2, index: 0, inPoint: 2 },
    { start: 2, duration: 2, index: 1, inPoint: 1 },
    { start: 4, duration: 2, index: 0, inPoint: 6 },
  ]);
  // 隐藏片段的边界不能把同一个 winner 拆开；排序也不能修改原数组。
  assert.deepEqual(clips.map((clip) => clip.index), [0, 1, 2]);
});

test("同轨 layer 越大越上层，覆盖结束恢复下层，同 layer 由较大 index 决胜", () => {
  const clips = normalizeMergeClips([
    { start: 1, inPoint: 3, outPoint: 7, track: 0, layer: 9 },
    { start: 0, inPoint: 0, outPoint: 6, track: 0, layer: 2 },
    { start: 2, inPoint: 0, outPoint: 1, track: 0, layer: 9 },
  ]);
  assert.deepEqual(plan(clips), [
    { start: 0, duration: 1, index: 1, inPoint: 0 },
    { start: 1, duration: 1, index: 0, inPoint: 3 },
    { start: 2, duration: 1, index: 2, inPoint: 0 },
    { start: 3, duration: 2, index: 0, inPoint: 5 },
    { start: 5, duration: 1, index: 1, inPoint: 5 },
  ]);
  assert.deepEqual(plan(normalizeMergeClips([{ duration: 2 }, { duration: 1 }])), [
    { start: 0, duration: 1, index: 1, inPoint: 0 },
    { start: 1, duration: 1, index: 0, inPoint: 1 },
  ]);
});

test("半开区间精确交接，初始空隙与不足 40 毫秒的空隙也保留", () => {
  const clips = normalizeMergeClips([
    { start: 0.5, inPoint: 1, outPoint: 1.25 },
    { start: 0.75, inPoint: 0, outPoint: 0.25 },
    { start: 1.03125, inPoint: 0, outPoint: 0.25 },
  ]);
  assert.deepEqual(plan(clips), [
    { start: 0, duration: 0.5 },
    { start: 0.5, duration: 0.25, index: 0, inPoint: 1 },
    { start: 0.75, duration: 0.25, index: 1, inPoint: 0 },
    { start: 1, duration: 0.03125 },
    { start: 1.03125, duration: 0.25, index: 2, inPoint: 0 },
  ]);
  assert.deepEqual(resolveTimelineSegments([]), []);
  const args = buildMergeArgs({
    clips: clips.map((clip) => ({ ...clip, file: `/tmp/${clip.index}.mp4` })),
    infos: clips.map(() => info()), output: "/tmp/out.mp4",
  });
  assert.match(args[args.indexOf("-filter_complex") + 1], /color=c=black[^;]*d=0\.031250/);
});

test("完全隐藏的镜头不参与输入，恢复片段的 infos 仍按原 index 查找", () => {
  const clips = normalizeMergeClips([
    { start: 1, inPoint: 1, outPoint: 2, track: 0 },
    { start: 0, inPoint: 0, outPoint: 3, track: 1, volume: 0.25 },
    { start: 0.5, inPoint: 0, outPoint: 1, track: 2 },
  ]).map((clip) => ({ ...clip, file: `/tmp/c${clip.index}.mp4` }));
  const args = buildMergeArgs({ clips, infos: [info({ hasAudio: false }), info(), info()], output: "/tmp/out.mp4" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  const inputs = args.flatMap((arg, index) => arg === "-i" ? [args[index + 1]] : []);
  assert.deepEqual(inputs, ["/tmp/c1.mp4", "/tmp/c0.mp4", "/tmp/c1.mp4"]);
  assert.match(graph, /\[2:v\]trim=start=2\.000:end=3\.000/);
  assert.match(graph, /\[2:a\]apad,atrim=start=2\.000:end=3\.000/);
  assert.doesNotMatch(graph, /\[1:a\]|amix/);
  assert.match(graph, /anullsrc[^;]*atrim=duration=1\.000[^;]*\[a1\]/);
  assert.equal((graph.match(/apad,atrim=start=/g) || []).length, 2);
});

test("normalize 与 parse 保留显式 layer，缺失和非有限值回退原 index+1", () => {
  const raw = [
    { duration: 1, layer: 8.5 }, { duration: 1 }, { duration: 1, layer: Infinity },
    { duration: 1, layer: NaN }, { duration: 1, layer: null }, { duration: 1, layer: 0 },
    { duration: 1, layer: -2 }, { duration: 1, layer: "17" },
  ];
  const expected = [8.5, 2, 3, 4, 5, 0, -2, 17];
  assert.deepEqual(parseMergeTimeline(raw).map((clip) => clip.layer), expected);
  assert.deepEqual(normalizeMergeClips(raw).map((clip) => clip.layer), expected);
  assert.deepEqual(normalizeMergeClips(parseMergeTimeline(JSON.stringify(raw))).map((clip) => clip.layer), expected);
  const [clip] = normalizeMergeClips([{ inPoint: Infinity, outPoint: Infinity, start: Infinity, track: Infinity }]);
  assert.ok(Object.values(clip).every(Number.isFinite));
});

test("resolveMergeSize 强制偶数并尊重显式尺寸", () => {
  assert.deepEqual(resolveMergeSize([info({ width: 1921, height: 1081 })]), { width: 1922, height: 1082 });
  assert.deepEqual(resolveMergeSize([info()], { width: 0, height: 0 }), { width: 1280, height: 720 });
  assert.deepEqual(resolveMergeSize([info()], { width: 640, height: 360 }), { width: 640, height: 360 });
  // 探不到尺寸时退回 720p，而不是 0x0。
  assert.deepEqual(resolveMergeSize([info({ width: 0, height: 0 })]), { width: 1280, height: 720 });
});

test("merge 会写出临时素材、调用 ffmpeg 并读回成片", async () => {
  const calls = [];
  const merger = createVideoMerger({
    config: { comfyDir: "/comfy" },
    // 不走真实 ffprobe：探针失败时合并仍应继续（宁可让 ffmpeg 自己报错）。
    execute: () => {
      throw new Error("no ffprobe");
    },
    run: async (bin, args) => {
      calls.push({ bin, args });
      // 模拟 ffmpeg 产出成片。
      await fsp.writeFile(args.at(-1), Buffer.from("merged"));
    },
  });
  const result = await merger.merge({
    clips: [
      { buffer: Buffer.from("a"), inPoint: 0, outPoint: 2, duration: 2, start: 0, track: 0 },
      { buffer: Buffer.from("b"), inPoint: 0, outPoint: 2, duration: 2, start: 2, track: 0 },
    ],
    requestId: "req1",
  });
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(result.buffer.toString(), "merged");
  assert.equal(calls.length, 1);
  // 首次尝试用 PATH 上的 ffmpeg，再回退到 ComfyUI 目录里的候选。
  assert.equal(calls[0].bin, "ffmpeg");
  // 临时文件必须清干净，否则每次导出都会在 /tmp 留几段视频。
  const workDir = path.dirname(calls[0].args.at(-1));
  assert.equal(fs.existsSync(workDir), false);
});

test("真实时长收缩后重新计算可见计划，不延长到伪造的最短时长", async () => {
  let args;
  const merger = createVideoMerger({
    execute: () => JSON.stringify({ streams: [{ codec_type: "video", width: 320, height: 180 }], format: { duration: 1 } }),
    run: async (_bin, inputArgs) => {
      args = inputArgs;
      await fsp.writeFile(args.at(-1), Buffer.from("merged"));
    },
  });
  await merger.merge({ clips: [{ buffer: Buffer.from("a"), start: 0, inPoint: 0.99, outPoint: 3 }] });
  assert.equal(args[args.indexOf("-t") + 1], "0.010");
  assert.match(args[args.indexOf("-filter_complex") + 1], /trim=start=0\.990:end=1\.000/);
});

for (const inPoint of [1, 2]) {
  test(`入点 ${inPoint}s 不小于真实时长 1s 时明确报参数错误且清理临时目录`, async () => {
    let workDir;
    let runs = 0;
    const merger = createVideoMerger({
      execute: (_bin, args) => {
        workDir = path.dirname(args.at(-1));
        return JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: 1 } });
      },
      run: async () => { runs += 1; },
    });
    await assert.rejects(
      () => merger.merge({ clips: [{ buffer: Buffer.from("a"), inPoint, outPoint: 3 }] }),
      (error) => error.status === 400 && error.code === "invalid_timeline" && /入点.*实际时长/.test(error.message),
    );
    assert.equal(runs, 0);
    assert.equal(fs.existsSync(workDir), false);
  });
}

test("缺少 ffmpeg 时给出可执行的安装提示", async () => {
  const merger = createVideoMerger({
    config: {},
    execute: () => {
      throw new Error("no ffprobe");
    },
    run: async (bin) => {
      const error = new Error(`${bin} not found`);
      error.code = "ENOENT";
      throw error;
    },
  });
  await assert.rejects(
    () => merger.merge({ clips: [{ buffer: Buffer.from("a"), inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0 }] }),
    (error) => /ffmpeg/.test(error.message) && /安装/.test(error.message),
  );
});

test("ffmpeg 报错时把最后几行 stderr 带出来", async () => {
  const merger = createVideoMerger({
    config: {},
    execute: () => {
      throw new Error("no ffprobe");
    },
    run: async () => {
      const error = new Error("Command failed");
      error.stderr = "line1\nInvalid data found when processing input\n";
      throw error;
    },
  });
  await assert.rejects(
    () => merger.merge({ clips: [{ buffer: Buffer.from("a"), inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0 }] }),
    (error) => /合并视频失败/.test(error.message) && /Invalid data found/.test(error.message),
  );
});

test("时间线允许 120 个片段并拒绝 121 个片段", () => {
  assert.equal(MAX_MERGE_CLIPS, 120);
  const timeline = Array.from({ length: 120 }, (_, source) => ({ source, duration: 1, start: source }));
  const parsed = parseMergeTimeline(JSON.stringify(timeline));
  assert.equal(parsed.length, 120);
  assert.equal(parsed.at(-1).source, 119);
  assert.throws(
    () => parseMergeTimeline([...timeline, { source: 120, duration: 1 }]),
    (error) => error.status === 400 && error.code === "too_many_clips",
  );
});

test("合并器允许完整 120 片段边界且不截断输入", async () => {
  const calls = [];
  const merger = createVideoMerger({
    execute: () => "{}",
    run: async (_bin, args) => {
      calls.push(args);
      await fsp.writeFile(args.at(-1), Buffer.from("merged"));
    },
  });
  const clips = Array.from({ length: 120 }, (_, start) => ({ buffer: Buffer.from("a"), duration: 1, start }));
  const result = await merger.merge({ clips });
  assert.equal(result.buffer.toString(), "merged");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filter((arg) => arg === "-i").length, 120);
  assert.match(calls[0][calls[0].indexOf("-filter_complex") + 1], /concat=n=120:v=1:a=1/);
});

test("合并片段数与空输入都被拦住", async () => {
  const merger = createVideoMerger({ config: {}, execute: () => "{}", run: async () => {} });
  await assert.rejects(() => merger.merge({ clips: [] }), /缺少视频片段/);
  const tooMany = Array.from({ length: MAX_MERGE_CLIPS + 1 }, () => ({ buffer: Buffer.from("a"), inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0 }));
  await assert.rejects(() => merger.merge({ clips: tooMany }), /一次最多合并/);
});

test("取消信号会终止 ffmpeg，而不是等它跑完", async () => {
  const controller = new AbortController();
  const killed = [];
  const merger = createVideoMerger({
    config: {},
    execute: () => {
      throw new Error("no ffprobe");
    },
    // 模拟「ffmpeg 一直不返回」：只有被 kill 才会走回调。
    execFileImpl: (bin, args, options, callback) => {
      void args;
      void options;
      void bin;
      return {
        kill(signal) {
          killed.push(signal);
          const error = new Error("killed");
          error.killed = true;
          callback(error, "", "");
        },
      };
    },
  });
  const promise = merger.merge({ clips: [{ buffer: Buffer.from("a"), inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0 }], signal: controller.signal });
  controller.abort();
  await assert.rejects(() => promise);
  // 取消不能转成「ffmpeg 不存在」，否则会误导用户去装 ffmpeg。
  assert.deepEqual(killed, ["SIGKILL"]);
});

test("临时工作目录在异常路径上也会被清掉", async () => {
  let workDir = "";
  const merger = createVideoMerger({
    config: {},
    execute: () => {
      throw new Error("no ffprobe");
    },
    run: async (bin, args) => {
      void bin;
      workDir = path.dirname(args.at(-1));
      throw Object.assign(new Error("boom"), { stderr: "boom" });
    },
  });
  await merger.merge({ clips: [{ buffer: Buffer.from("a"), inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0 }] }).catch(() => undefined);
  assert.ok(workDir);
  assert.equal(fs.existsSync(workDir), false);
  void os;
});

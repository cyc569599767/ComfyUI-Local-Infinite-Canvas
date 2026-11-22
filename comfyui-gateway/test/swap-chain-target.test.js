// 换人目标框与提示词。
//
// 现场缺陷：7s 单人物视频（人物居中/偏近景）跑换人，图像门失败，
// painted 产物直接是参考图本身。根因是 single_swap 默认框永远取右半幅
// （x=0.51,w=0.45），提示词据此说「画面右侧人物」—— 画面里没有右侧人物，
// 模型就把参考图整个吐出来。
import assert from "node:assert/strict";
import test from "node:test";

import { buildSingleSwapPrompt, buildSwapVideoPrompt, defaultTargetBoxes, describeTarget, describeTargetEn, FULL_FRAME_BOX, isFullFrameBox, isPromptInQueue, judgeImageGate, judgeVideoGate, pixelCorrelation } from "../src/swap-chain-target.js";

test("单人影默认用整幅框，不再赌半幅", () => {
  const boxes = defaultTargetBoxes("single_swap", "把视频里的人换成参考图中的角色");
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], FULL_FRAME_BOX);
  assert.equal(isFullFrameBox(boxes[0]), true);
});

test("intent 明确只说一侧时才收窄到该半幅", () => {
  const left = defaultTargetBoxes("single_swap", "只换左边那个人");
  assert.equal(left.length, 1);
  assert.ok(left[0].x < 0.1 && left[0].width < 0.5, "应是左半幅");

  const right = defaultTargetBoxes("single_swap", "只换右边那个人");
  assert.ok(right[0].x > 0.4, "应是右半幅");

  // 两侧都提到 → 无法判断，回到整幅
  const both = defaultTargetBoxes("single_swap", "左右两边的人都要换");
  assert.deepEqual(both[0], FULL_FRAME_BOX);
});

test("双人影仍是左右半幅（这种模式确实有两个人）", () => {
  const boxes = defaultTargetBoxes("double_swap", "");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].x, 0.04);
  assert.equal(boxes[1].x, 0.51);
});

test("编辑类模式不框选，交给整图理解", () => {
  for (const mode of ["edit_clothes", "edit_light", "edit_time"]) {
    assert.deepEqual(defaultTargetBoxes(mode, ""), [], mode);
  }
});

test("整幅框描述为「画面中的人物」，不能是「画面右侧人物」", () => {
  // 这是缺陷的核心：说「右侧」会让模型去右边找人
  const desc = describeTarget(FULL_FRAME_BOX);
  assert.equal(desc, "画面中的人物");
  assert.doesNotMatch(desc, /右/);
  assert.doesNotMatch(desc, /左/);
});

test("半幅框仍按位置描述", () => {
  assert.equal(describeTarget({ x: 0.51, y: 0.03, width: 0.45, height: 0.94 }), "画面右侧人物");
  assert.equal(describeTarget({ x: 0.04, y: 0.03, width: 0.45, height: 0.94 }), "画面左侧人物");
  assert.equal(describeTarget(null), "目标人物");
});

test("提示词明确区分第 1 张（角色）与第 2 张（源图）", () => {
  const prompt = buildSingleSwapPrompt(FULL_FRAME_BOX);
  // 必须点名图片编号，否则 Qwen 分不清谁是底图、谁是角色参考
  assert.match(prompt, /第 1 张参考图/);
  assert.match(prompt, /第 2 张参考图/);
  assert.match(prompt, /画面中的人物/);
  assert.doesNotMatch(prompt, /画面右侧人物/);
  // 保持类的约束要在
  assert.match(prompt, /姿势/);
  assert.match(prompt, /背景/);
  assert.match(prompt, /光照/);
});

test("提示词不再硬编码「茶具」等具体场景词", () => {
  // 原 prompt 里带「茶具」，通用场景里没有这东西，会干扰模型
  const prompt = buildSingleSwapPrompt(FULL_FRAME_BOX);
  assert.doesNotMatch(prompt, /茶具/);
});

test("isFullFrameBox 容忍浮点误差，也认得接近整幅的框", () => {
  assert.equal(isFullFrameBox({ x: 0, y: 0, width: 1, height: 1 }), true);
  assert.equal(isFullFrameBox({ x: 0.005, y: 0.01, width: 0.99, height: 0.985 }), true);
  assert.equal(isFullFrameBox({ x: 0.5, y: 0, width: 0.5, height: 1 }), false);
  assert.equal(isFullFrameBox(null), false);
});

test("视频阶段用英文描述，不能把中文标签拼进英文提示词", () => {
  // 现场缺陷：swap-chain.js 的 buildSwapVideoPrompt 里还在调已删除的
  // targetLabel()，任务跑到 s5_video 直接报 "targetLabel is not defined"。
  // 图像门（s4）已经过了，等于最后一步才炸，代价最大。
  const en = describeTargetEn(FULL_FRAME_BOX);
  assert.equal(en, "person in the video");
  assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, "英文提示词里不该出现中文");
  assert.doesNotMatch(en, /right/i, "整幅框不能说 right，否则模型去右边找人");

  assert.equal(describeTargetEn({ x: 0.51, y: 0.03, width: 0.45, height: 0.94 }), "person on the right");
  assert.equal(describeTargetEn({ x: 0.04, y: 0.03, width: 0.45, height: 0.94 }), "person on the left");
  assert.equal(describeTargetEn(null), "target person");
});

test("单人影视频提示词里不出现「另一个人」", () => {
  // 单人视频里没有第二个人，写 "The other person is not replaced"
  // 会让模型去找一个不存在的角色
  const job = { mode: "single_swap", intent: "", targetBoxes: [FULL_FRAME_BOX] };
  const prompt = buildSwapVideoPrompt(job);
  assert.doesNotMatch(prompt, /The other person is not replaced/);
  assert.doesNotMatch(prompt, /The other person \(not a Subject\)/);
  assert.match(prompt, /No other person changes/);
});

test("视频门不能用第 0 帧做硬门槛（现场数据）", () => {
  // 现场：四个采样帧 targetDiff = [3.82, 32.28, 48.09, 52.07]，
  // 换人整体成功，但原实现取全帧最小值 3.82 → 判不合格 → 白跑一次视频。
  const readings = [
    { frame: 0, targetDiff: 3.82, outsideDiff: 0, luma: 78 },
    { frame: 32, targetDiff: 32.28, outsideDiff: 0, luma: 81.6 },
    { frame: 64, targetDiff: 48.09, outsideDiff: 0, luma: 74.4 },
    { frame: 96, targetDiff: 52.07, outsideDiff: 0, luma: 97.9 },
  ];
  const verdict = judgeVideoGate({ readings, mode: "single_swap" });
  assert.equal(verdict.startDiff, 3.82, "起始帧要单独记录");
  assert.equal(verdict.targetMin, 32.28, "门槛应只看非起始帧");
  assert.equal(verdict.targetOk, true);
  assert.equal(verdict.pass, true, "这条视频应该通过");
});

test("真的没换人时仍要拦下来（不能因为放宽而失效）", () => {
  // 所有帧都没怎么变 → 必须 fail，否则门形同虚设
  const readings = [
    { frame: 0, targetDiff: 0.5, outsideDiff: 0, luma: 80 },
    { frame: 32, targetDiff: 1.2, outsideDiff: 0, luma: 80 },
    { frame: 64, targetDiff: 2.0, outsideDiff: 0, luma: 80 },
    { frame: 96, targetDiff: 3.1, outsideDiff: 0, luma: 80 },
  ];
  const verdict = judgeVideoGate({ readings, mode: "single_swap" });
  assert.equal(verdict.targetOk, false);
  assert.equal(verdict.pass, false);
});

test("背景崩坏、全黑仍然拦下", () => {
  const noBgChange = [
    { frame: 0, targetDiff: 40, outsideDiff: 0, luma: 80 },
    { frame: 32, targetDiff: 45, outsideDiff: 75, luma: 80 },
    { frame: 64, targetDiff: 50, outsideDiff: 0, luma: 80 },
    { frame: 96, targetDiff: 52, outsideDiff: 0, luma: 80 },
  ];
  assert.equal(judgeVideoGate({ readings: noBgChange, mode: "single_swap" }).backgroundOk, false);

  const dark = [
    { frame: 0, targetDiff: 40, outsideDiff: 0, luma: 3 },
    { frame: 32, targetDiff: 45, outsideDiff: 0, luma: 3 },
  ];
  assert.equal(judgeVideoGate({ readings: dark, mode: "single_swap" }).blackOk, false);
});

test("编辑光效/时间时背景允许大幅改变", () => {
  const readings = [
    { frame: 0, targetDiff: 40, outsideDiff: 90, luma: 20 },
    { frame: 32, targetDiff: 45, outsideDiff: 90, luma: 25 },
  ];
  assert.equal(judgeVideoGate({ readings, mode: "edit_light" }).backgroundOk, true);
  assert.equal(judgeVideoGate({ readings, mode: "edit_time" }).backgroundOk, true);
  assert.equal(judgeVideoGate({ readings, mode: "single_swap" }).backgroundOk, false);
});

test("采样点不足时退回全帧最小值，且空输入不炸", () => {
  assert.equal(judgeVideoGate({ readings: [] }).pass, false);
  const single = [{ frame: 0, targetDiff: 40, outsideDiff: 0, luma: 80 }];
  assert.equal(judgeVideoGate({ readings: single }).targetMin, 40);
});

test("任务丢失判定：不在队列也不在历史时才能认定丢失", () => {
  const pid = "abc-123";
  // 正在执行
  assert.equal(isPromptInQueue({ queue_running: [[1, pid, {}, {}, []]], queue_pending: [] }, pid), true);
  // 排队中
  assert.equal(isPromptInQueue({ queue_running: [], queue_pending: [[2, pid, {}, {}, []]] }, pid), true);
  // 队列里没有它 —— 已经被丢了
  assert.equal(isPromptInQueue({ queue_running: [], queue_pending: [] }, pid), false);
  assert.equal(isPromptInQueue({ queue_running: [[1, "other", {}, {}, []]], queue_pending: [] }, pid), false);
});

test("队列接口异常时不能误判任务丢失（宁可继续等）", () => {
  assert.equal(isPromptInQueue(null, "abc"), true);
  assert.equal(isPromptInQueue(undefined, "abc"), true);
  assert.equal(isPromptInQueue({}, "abc"), true);
  // 结构异常也不该抛出，更不能据此判定任务丢失
  assert.equal(isPromptInQueue({ queue_running: "oops", queue_pending: 3 }, "abc"), true);
  // 空 promptId 不具备判定意义
  assert.equal(isPromptInQueue({ queue_running: [], queue_pending: [] }, ""), true);
});

// ── 图像门必须挡住「整图重画」 ────────────────────────────────────────
//
// 现场事故：模型没做换人，而是重画了整张图（西装近景 → 古风人物在海面
// 施法）。图像门却判 pass，把这张图送去做视频，于是出现「领带变成钢铁侠
// 反应堆」的离谱过渡，白烧 30 分钟。

test("逐像素相关能识别整图重画，直方图相关不行", () => {
  // 构一组「结构相同」与「结构不同但色调相同」的网格数据
  const flat = new Array(64 * 36 * 3).fill(120);
  // A：左亮右暗
  const a = flat.map((_, i) => (i % (64 * 3) < 32 * 3 ? 200 : 60));
  // B：与 A 同构图（同坐标同值）
  const b = [...a];
  // C：同色调分布、但构图完全不同（亮暗互换）
  const c = a.map((v) => (v === 200 ? 60 : 200));

  assert.ok(pixelCorrelation(a, b) > 0.99, "同构图应该接近 1");
  assert.ok(pixelCorrelation(a, c) < 0, "亮暗互换应该是负相关");
});

test("整幅框下构图崩塌必须判不合格（现场数据）", () => {
  // 现场实测：targetDiff 很高（画面确实变了），但逐像素相关只有 0.3658
  const verdict = judgeImageGate({
    outsideDiff: 0,
    targetDiff: 75.84,
    structureCorr: 0.3658,
    fullFrame: true,
    mode: "single_swap",
    identity: [{ ref: "ref-0.png", hit: true }],
  });
  assert.equal(verdict.changedOk, true, "画面确实变了");
  assert.equal(verdict.outsideOk, false, "但构图崩了，必须拦下");
  assert.equal(verdict.pass, false);
});

test("正常换人（构图保留）仍然放行", () => {
  // 只改人脸时逐像素相关应在 0.8 以上
  const verdict = judgeImageGate({
    outsideDiff: 0,
    targetDiff: 40,
    structureCorr: 0.82,
    fullFrame: true,
    mode: "single_swap",
    identity: [{ ref: "ref-0.png", hit: true }],
  });
  assert.equal(verdict.pass, true);
});

test("半幅框仍用框外差异判定，不受结构阈值影响", () => {
  const okVerdict = judgeImageGate({
    outsideDiff: 10,
    targetDiff: 40,
    structureCorr: 0.1, // 半幅框下这个值不参与判定
    fullFrame: false,
    mode: "single_swap",
  });
  assert.equal(okVerdict.pass, true, "框外基本没变就该过");

  const badVerdict = judgeImageGate({
    outsideDiff: 90,
    targetDiff: 40,
    structureCorr: 1,
    fullFrame: false,
    mode: "single_swap",
  });
  assert.equal(badVerdict.outsideOk, false, "框外被改太多应拦下");
});

test("没换到人（targetDiff 太低）仍然拦下", () => {
  const verdict = judgeImageGate({
    outsideDiff: 0,
    targetDiff: 3,
    structureCorr: 0.95,
    fullFrame: true,
    mode: "single_swap",
  });
  assert.equal(verdict.changedOk, false);
  assert.equal(verdict.pass, false);
});

test("编辑光效/时间允许整图改变（此时不看结构相关）", () => {
  const verdict = judgeImageGate({
    outsideDiff: 95,
    targetDiff: 60,
    structureCorr: 0.2,
    fullFrame: true,
    mode: "edit_light",
  });
  assert.equal(verdict.outsideOk, true);
  assert.equal(verdict.pass, true);
});

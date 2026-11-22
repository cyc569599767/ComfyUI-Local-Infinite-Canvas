// 换人目标框与提示词。
//
// 现场缺陷：7s 单人物视频（人物居中/偏近景）跑换人，图像门失败，
// painted 产物直接是参考图本身。根因是 single_swap 默认框永远取右半幅
// （x=0.51,w=0.45），提示词据此说「画面右侧人物」—— 画面里没有右侧人物，
// 模型就把参考图整个吐出来。
import assert from "node:assert/strict";
import test from "node:test";

import { buildSingleSwapPrompt, defaultTargetBoxes, describeTarget, FULL_FRAME_BOX, isFullFrameBox } from "../src/swap-chain-target.js";

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

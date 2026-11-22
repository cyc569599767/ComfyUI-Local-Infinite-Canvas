// H3 画布像素上限：4K 卡片会算出 3840x2176 = 8,355,840，是上限 4 倍。
//
// 现场报错：节点 76 (MiniMaxH3AudioConditioningT8)
//   ValueError: Requested canvas has 8,355,840 pixels and exceeds the configured
//   MiniMax H3 reference area of 2,088,960 pixels (1920x1088)
import assert from "node:assert/strict";
import test from "node:test";

import { exceedsH3PixelLimit, fitSizeToH3Limit, h3PixelLimitMessage, H3_MAX_PIXELS, snap32 } from "../src/h3-canvas-limit.js";

test("上限就是 1920x1088", () => {
    assert.equal(H3_MAX_PIXELS, 2088960);
    assert.equal(snap32(1920) * snap32(1088), H3_MAX_PIXELS);
});

test("snap32 对齐到 32 倍数（4K 的 2160 会被抬成 2176）", () => {
    assert.equal(snap32(3840), 3840);
    assert.equal(snap32(2160), 2176);
    assert.equal(snap32(1080), 1088);
    assert.equal(snap32(720), 736);
    // 不能返回 0 或负数
    assert.equal(snap32(0), 32);
    assert.equal(snap32(-100), 32);
});

test("4K 卡片（3840x2160）会被判定超限", () => {
    assert.equal(exceedsH3PixelLimit(3840, 2160), true);
    // 复现报错里的具体像素数
    const w = snap32(3840), h = snap32(2160);
    assert.equal(w * h, 8355840);
    assert.ok(w * h > H3_MAX_PIXELS * 3.9, "约为上限的 4 倍");
});

test("1080p 各比例：16:9 与 9:16 刚好在上限内，21:9 超限", () => {
    assert.equal(exceedsH3PixelLimit(1920, 1080), false); // 2,073,600
    assert.equal(exceedsH3PixelLimit(1080, 1920), false);
    assert.equal(exceedsH3PixelLimit(2520, 1080), true); // 21:9 = 2,721,600
});

test("720p / 480p 全部在上限内", () => {
    for (const [w, h] of [[1280, 720], [720, 1280], [960, 720], [1680, 720], [854, 480], [480, 854]]) {
        assert.equal(exceedsH3PixelLimit(w, h), false, `${w}x${h} 不该超限`);
    }
});

test("超限尺寸会被等比缩到上限内，且比例不变", () => {
    const fit = fitSizeToH3Limit(3840, 2160);
    assert.equal(fit.scaled, true);
    assert.ok(fit.width * fit.height <= H3_MAX_PIXELS, `缩放后仍超限：${fit.width}x${fit.height}`);
    // 比例接近 16:9（32 对齐会带来少量偏差）
    const ratio = fit.width / fit.height;
    assert.ok(Math.abs(ratio - 16 / 9) < 0.06, `比例跑偏：${ratio}`);
    // 宽高都是 32 的倍数
    assert.equal(fit.width % 32, 0);
    assert.equal(fit.height % 32, 0);
});

test("未超限的尺寸原样返回，不做无谓缩放", () => {
    assert.deepEqual(fitSizeToH3Limit(1280, 720), { width: 1280, height: 736, scaled: false });
    assert.deepEqual(fitSizeToH3Limit(1920, 1080), { width: 1920, height: 1088, scaled: false });
});

test("21:9 超限后会缩到上限内", () => {
    const fit = fitSizeToH3Limit(2520, 1080);
    assert.equal(fit.scaled, true);
    assert.ok(fit.width * fit.height <= H3_MAX_PIXELS);
});

test("报错文案说清上限、当前值、超出比例与建议尺寸", () => {
    const message = h3PixelLimitMessage(3840, 2160);
    assert.match(message, /2,088,960/);
    assert.match(message, /3840×2176/);
    assert.match(message, /8,355,840/);
    assert.match(message, /超出/);
    assert.match(message, /请降到/);
});

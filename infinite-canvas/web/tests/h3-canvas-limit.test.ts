// H3 画布像素上限（前端前置校验）。
//
// 现场：4K 卡片（3840x2160）经 snap32 变成 3840x2176 = 8,355,840，
// 是 H3 上限 2,088,960 的 4 倍，跑到 ComfyUI 才由 conditioning 节点抛 ValueError。
import { expect, test } from "bun:test";
import { checkH3CanvasLimit, fitCanvasToH3Limit, H3_CANVAS_MAX_PIXELS, snapTo32 } from "../src/lib/canvas/h3-canvas-limit";

test("上限是 1920×1088", () => {
    expect(H3_CANVAS_MAX_PIXELS).toBe(2088960);
});

test("snapTo32 把 4K 的 2160 抬成 2176（复现报错尺寸）", () => {
    expect(snapTo32(3840)).toBe(3840);
    expect(snapTo32(2160)).toBe(2176);
    expect(snapTo32(1080)).toBe(1088);
    expect(snapTo32(0)).toBe(32);
});

test("4K 卡片被拦下，并给出建议尺寸", () => {
    const result = checkH3CanvasLimit("3840x2160");
    expect(result.exceeded).toBe(true);
    if (!result.exceeded) return;
    // 复现报错里的 8,355,840
    expect(result.message).toContain("8,355,840");
    expect(result.message).toContain("3840×2176");
    expect(result.message).toContain("2,088,960");
    expect(result.suggested.width * result.suggested.height).toBeLessThanOrEqual(H3_CANVAS_MAX_PIXELS);
});

test("1080p 常规比例放行，21:9 拦下", () => {
    expect(checkH3CanvasLimit("1920x1080").exceeded).toBe(false);
    expect(checkH3CanvasLimit("1080x1920").exceeded).toBe(false);
    expect(checkH3CanvasLimit("1280x720").exceeded).toBe(false);
    // 21:9 的 1080p 是 2,721,600，超限
    expect(checkH3CanvasLimit("2520x1080").exceeded).toBe(true);
});

test("720p / 480p 各比例都放行", () => {
    for (const size of ["1280x720", "720x1280", "960x720", "1680x720", "854x480", "480x854"]) {
        expect({ size, exceeded: checkH3CanvasLimit(size).exceeded }).toEqual({ size, exceeded: false });
    }
});

test("auto 等非像素尺寸交给后端按档位算，不拦", () => {
    for (const size of ["auto", "", "16:9", "invalid"]) {
        expect(checkH3CanvasLimit(size).exceeded).toBe(false);
    }
});

test("缩放后仍保持宽高比且是 32 的倍数", () => {
    const fit = fitCanvasToH3Limit(3840, 2160);
    expect(fit.width * fit.height).toBeLessThanOrEqual(H3_CANVAS_MAX_PIXELS);
    expect(fit.width % 32).toBe(0);
    expect(fit.height % 32).toBe(0);
    expect(Math.abs(fit.width / fit.height - 16 / 9)).toBeLessThan(0.06);
});

test("未超限尺寸原样返回（只做 32 对齐）", () => {
    expect(fitCanvasToH3Limit(1280, 720)).toEqual({ width: 1280, height: 736 });
    expect(fitCanvasToH3Limit(1920, 1080)).toEqual({ width: 1920, height: 1088 });
});

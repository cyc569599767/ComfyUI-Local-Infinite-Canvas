// 图片/视频卡片标题后的分辨率标签。
//
// 用户诉求：「视频卡或者图片卡需要在画布上的名称后面位置显示分辨率（灰色）」。
// 这里锁住换算规则，重点是别显示假数据 —— 缺元数据时宁可回落到卡片尺寸，
// 也不能出现 "0 × 0" 或拿真实宽配渲染高算出的错误比例。
import { expect, test } from "bun:test";
import { formatResolutionLabel, resolveNodeResolution } from "../src/lib/canvas/node-resolution-label";

const node = (width: number, height: number, metadata: Record<string, unknown> = {}) => ({ width, height, metadata }) as Parameters<typeof formatResolutionLabel>[0];

test("优先用素材真实分辨率", () => {
    // 卡片在画布上被缩到 360×202，但素材是 1920×1080，应显示后者。
    expect(formatResolutionLabel(node(360, 202, { naturalWidth: 1920, naturalHeight: 1080 }))).toBe("1920 × 1080");
});

test("竖屏素材也能正确显示", () => {
    expect(formatResolutionLabel(node(200, 356, { naturalWidth: 1080, naturalHeight: 1920 }))).toBe("1080 × 1920");
});

test("缺元数据时回落到卡片渲染尺寸，不显示 0 × 0", () => {
    expect(formatResolutionLabel(node(320, 320))).toBe("320 × 320");
    expect(formatResolutionLabel(node(320, 320, {}))).toBe("320 × 320");
});

test("只拿到一半的真实尺寸时不用它（否则宽高比会算错）", () => {
    // 视频还没触发 loadedmetadata 时可能只有 naturalWidth。
    // 若拿 1920 配渲染高 202，会得出 1920×202 这种错误比例。
    expect(formatResolutionLabel(node(360, 202, { naturalWidth: 1920 }))).toBe("360 × 202");
    expect(formatResolutionLabel(node(360, 202, { naturalHeight: 1080 }))).toBe("360 × 202");
});

test("无效尺寸返回 null，不渲染标签", () => {
    expect(formatResolutionLabel(node(0, 0))).toBeNull();
    expect(formatResolutionLabel(node(0, 0, { naturalWidth: 0, naturalHeight: 0 }))).toBeNull();
    expect(resolveNodeResolution(node(0, 0))).toBeNull();
});

test("负数与非数字不当作有效尺寸", () => {
    expect(resolveNodeResolution(node(-100, -50))).toBeNull();
    expect(formatResolutionLabel(node(Number.NaN, Number.NaN))).toBeNull();
    expect(formatResolutionLabel(node(360, 202, { naturalWidth: -1, naturalHeight: -1 }))).toBe("360 × 202");
});

test("小数尺寸四舍五入，不出现 1919.98", () => {
    expect(formatResolutionLabel(node(360, 202, { naturalWidth: 1919.98, naturalHeight: 1080.4 }))).toBe("1920 × 1080");
});

test("真实尺寸优先于渲染尺寸（即使渲染尺寸更大）", () => {
    // 放大预览时卡片可能比素材还大，仍应显示素材本身的分辨率。
    expect(formatResolutionLabel(node(2560, 1440, { naturalWidth: 1280, naturalHeight: 720 }))).toBe("1280 × 720");
});

test("用 × 号而不是字母 x（中文界面里 x 容易看成变量名）", () => {
    const label = formatResolutionLabel(node(1920, 1080));
    expect(label).toContain("×");
    expect(label).not.toContain("x");
});

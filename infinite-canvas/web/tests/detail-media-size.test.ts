// 详情弹窗（图片详情 / 视频详情）的分辨率展示。
//
// 需求：详情卡片要显示分辨率。数据有三个来源，优先级不能搞错：
// 批次里具体那张图 > 节点级 metadata > 都不全时不显示（宁可没有，也不显示错比例）。
import { expect, test } from "bun:test";
import { formatDetailMediaSize, resolveDetailMediaSize } from "../src/lib/canvas/detail-media-size";

test("优先用批次里具体那张图的尺寸", () => {
    // 批次里每张图尺寸可能不同，必须按当前这张显示
    expect(resolveDetailMediaSize({ naturalWidth: 1920, naturalHeight: 1080 }, { naturalWidth: 720, naturalHeight: 480 })).toEqual({ width: 1920, height: 1080 });
});

test("批次项缺尺寸时回落到节点级", () => {
    expect(resolveDetailMediaSize({}, { naturalWidth: 1280, naturalHeight: 720 })).toEqual({ width: 1280, height: 720 });
    expect(resolveDetailMediaSize(null, { naturalWidth: 1280, naturalHeight: 720 })).toEqual({ width: 1280, height: 720 });
    expect(resolveDetailMediaSize(undefined, { naturalWidth: 1280, naturalHeight: 720 })).toEqual({ width: 1280, height: 720 });
});

test("只有一半尺寸时不采用（否则宽高比算错）", () => {
    // 视频可能还没 loadedmetadata，只有 naturalWidth
    expect(resolveDetailMediaSize({ naturalWidth: 1920 }, { naturalHeight: 1080 })).toBeNull();
    expect(resolveDetailMediaSize({ naturalWidth: 1920, naturalHeight: 0 }, null)).toBeNull();
});

test("两者都缺失时返回 null，不渲染标签", () => {
    expect(resolveDetailMediaSize(null, null)).toBeNull();
    expect(resolveDetailMediaSize({}, {})).toBeNull();
    expect(formatDetailMediaSize(null)).toBeNull();
});

test("负数与 NaN 不当有效尺寸", () => {
    expect(resolveDetailMediaSize({ naturalWidth: -1920, naturalHeight: -1080 }, null)).toBeNull();
    expect(resolveDetailMediaSize({ naturalWidth: Number.NaN, naturalHeight: Number.NaN }, null)).toBeNull();
});

test("小数四舍五入，不出现 1919.98", () => {
    expect(resolveDetailMediaSize({ naturalWidth: 1919.98, naturalHeight: 1080.4 }, null)).toEqual({ width: 1920, height: 1080 });
});

test("格式化用 × 而不是字母 x，带空格", () => {
    expect(formatDetailMediaSize({ width: 1920, height: 1080 })).toBe("1920 × 1080");
    expect(formatDetailMediaSize({ width: 1080, height: 1920 })).toBe("1080 × 1920");
    expect(formatDetailMediaSize({ width: 1280, height: 720 })).toBe("1280 × 720");
});

test("竖屏视频尺寸正确显示", () => {
    expect(formatDetailMediaSize(resolveDetailMediaSize(null, { naturalWidth: 1080, naturalHeight: 1920 }))).toBe("1080 × 1920");
});

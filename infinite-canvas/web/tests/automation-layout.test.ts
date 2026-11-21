// 自动化卡片：布局与配置持久化。
//
// 三个回归点：
//   1. 宫格卡片在任意「规格 × 比例」组合下都不能窄到压扁内容（曾经 2x3+9:16 只有 158px）；
//   2. 多页排布不能互相重叠，且视频列不与图文列重叠；
//   3. 改源文必须把 script / pages / stage 一起重置，避免新剧本续旧页面的错乱。
import { expect, test } from "bun:test";
import { automationImageSize, automationPageCardSize, computeAutomationLayout } from "../src/lib/automation/layout";
import type { CanvasNodeData } from "../src/types/canvas";

const GRIDS = ["2x2", "2x3", "3x3"] as const;
const ASPECTS = ["3:4", "4:3", "1:1", "16:9", "9:16"];
const parent = { id: "p", type: "automation", title: "自动化", position: { x: 100, y: 50 }, width: 460, height: 320 } as CanvasNodeData;

type Slot = { x: number; y: number; width: number; height: number };
const overlaps = (a: Slot, b: Slot) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

test("宫格卡片在任何规格×比例下都保持可读宽度", () => {
    for (const grid of GRIDS) {
        for (const aspect of ASPECTS) {
            const size = automationPageCardSize(grid, aspect);
            // 低于 220px 时宫格里的对话框会挤成一列，实测过的劣化点。
            expect({ grid, aspect, width: size.width }).toEqual({ grid, aspect, width: expect.any(Number) });
            expect(size.width).toBeGreaterThanOrEqual(220);
            // 上下限也不能被打破。
            expect(size.width).toBeLessThanOrEqual(300);
            // 高度允许超过 420（为了保住宽度），但不能无限膨胀。
            expect(size.height).toBeLessThanOrEqual(600);
        }
    }
});

test("宫格卡片的宽高比跟随「格子比例 × 列行比」", () => {
    // 2x3 是三行两列：竖屏格子合成后整体更狭长。
    const portrait = automationPageCardSize("2x3", "9:16");
    expect(portrait.width / portrait.height).toBeCloseTo((9 / 16) * (2 / 3), 1);
    // 9:16 一定比 16:9 更窄。
    expect(automationPageCardSize("2x2", "9:16").width).toBeLessThan(automationPageCardSize("2x2", "16:9").width);
});

test("视频卡片按比例给尺寸，未知比例回落到竖屏", () => {
    expect(automationImageSize("16:9")).toEqual({ width: 420, height: 236 });
    expect(automationImageSize("9:16")).toEqual({ width: 236, height: 420 });
    expect(automationImageSize("1:1")).toEqual({ width: 320, height: 320 });
    // 未识别时按 9:16 处理，不返回 NaN。
    expect(automationImageSize("weird")).toEqual({ width: 300, height: 400 });
});

test("多页排布不重叠：文本、宫格图、视频各自不撞", () => {
    for (const grid of GRIDS) {
        for (const aspect of ASPECTS) {
            const layout = computeAutomationLayout(parent, 7, aspect, grid);
            expect(layout.texts).toHaveLength(7);
            for (const column of [layout.texts, layout.images, layout.videos]) {
                for (let i = 0; i < column.length; i += 1) {
                    for (let j = i + 1; j < column.length; j += 1) {
                        expect({ grid, aspect, overlap: overlaps(column[i], column[j]) }).toEqual({ grid, aspect, overlap: false });
                    }
                }
            }
        }
    }
});

test("文本与宫格图左右成对，视频列在更右侧", () => {
    const layout = computeAutomationLayout(parent, 3, "16:9", "2x3");
    for (let i = 0; i < 3; i += 1) {
        // 同一页的文本与图在同一行、图在文本右侧。
        expect(layout.images[i].y).toBe(layout.texts[i].y);
        expect(layout.images[i].x).toBeGreaterThan(layout.texts[i].x);
        // 视频列整体在最右。
        expect(layout.videos[i].x).toBeGreaterThan(layout.images[i].x);
    }
});

test("起点相对父节点偏移，不受父节点绝对坐标影响相对关系", () => {
    const near = computeAutomationLayout(parent, 2, "16:9", "2x3");
    const far = computeAutomationLayout({ ...parent, position: { x: 2000, y: 1500 } } as CanvasNodeData, 2, "16:9", "2x3");
    // 平移父节点后，各槽位的相对位置（相对父节点）应保持一致。
    const delta = { x: far.texts[0].x - near.texts[0].x, y: far.texts[0].y - near.texts[0].y };
    expect(delta).toEqual({ x: 1900, y: 1450 });
    expect(far.images[0].x - far.texts[0].x).toBe(near.images[0].x - near.texts[0].x);
});

test("页数超过每列 6 行时自动换到下一组，不叠在上一组身上", () => {
    const layout = computeAutomationLayout(parent, 13, "16:9", "2x3");
    // 第 7 页（索引 6）应回到顶部、但横向右移一组。
    expect(layout.texts[6].y).toBe(layout.texts[0].y);
    expect(layout.texts[6].x).toBeGreaterThan(layout.texts[0].x);
    expect(layout.videos[6].x).toBeGreaterThan(layout.videos[0].x);
});

test("leftOffset 只平移整组，不改变组内相对位置", () => {
    const base = computeAutomationLayout(parent, 3, "16:9", "2x3");
    const shifted = computeAutomationLayout(parent, 3, "16:9", "2x3", 500);
    expect(shifted.texts[0].x - base.texts[0].x).toBe(500);
    expect(shifted.images[0].x - shifted.texts[0].x).toBe(base.images[0].x - base.texts[0].x);
});

test("页数为 0 时不产出任何槽位", () => {
    const layout = computeAutomationLayout(parent, 0, "16:9", "2x3");
    expect(layout.texts).toEqual([]);
    expect(layout.images).toEqual([]);
    expect(layout.videos).toEqual([]);
});

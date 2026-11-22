// H3 视频画布的像素上限（前端前置校验）。
//
// 与网关 src/h3-canvas-limit.js 保持同一套数字与规则：
// H3 的 conditioning 节点 MAX_PIXELS = 1920 * 1088 = 2,088,960，超出直接
// ValueError。4K 卡片（3840x2160）经 snap32 变成 3840x2176 = 8,355,840，
// 是上限的 4 倍 —— 不提前拦就要白等一轮 GPU。
//
// 注意别复用 MEDIA_MAX_PIXELS（8,294,400）：那是通用的媒体像素预算，
// 比 H3 的实际上限宽 4 倍，用它拦不住问题。

export const H3_CANVAS_MAX_PIXELS = 1920 * 1088;
const STEP = 32;

/** 对齐到 32 的倍数（H3 要求宽高可被 32 整除）。 */
export function snapTo32(value: number) {
    return Math.max(STEP, Math.round((Number(value) || 0) / STEP) * STEP);
}

/** 等比缩到上限内，宽高仍是 32 的倍数。 */
export function fitCanvasToH3Limit(width: number, height: number) {
    const w = snapTo32(width);
    const h = snapTo32(height);
    if (w * h <= H3_CANVAS_MAX_PIXELS) return { width: w, height: h };
    const scale = Math.sqrt(H3_CANVAS_MAX_PIXELS / (w * h));
    let nextW = snapTo32(w * scale);
    let nextH = snapTo32(h * scale);
    while (nextW * nextH > H3_CANVAS_MAX_PIXELS && (nextW > STEP || nextH > STEP)) {
        if (nextW >= nextH) nextW = Math.max(STEP, nextW - STEP);
        else nextH = Math.max(STEP, nextH - STEP);
    }
    return { width: nextW, height: nextH };
}

export type H3CanvasLimitCheck = { exceeded: false } | { exceeded: true; message: string; suggested: { width: number; height: number } };

/**
 * 检查请求尺寸是否超出 H3 上限。
 *
 * 「auto」等非像素尺寸（让网关按档位算）直接放行 —— 那种情况下后端会用
 * resolution + ratio 组合出的尺寸，档位最高 1080p，16:9/9:16 都在上限内。
 */
export function checkH3CanvasLimit(size: string): H3CanvasLimitCheck {
    const match = /^(\d+)\s*[x*×]\s*(\d+)$/i.exec(String(size || "").trim());
    if (!match) return { exceeded: false };
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return { exceeded: false };
    const w = snapTo32(width);
    const h = snapTo32(height);
    const pixels = w * h;
    if (pixels <= H3_CANVAS_MAX_PIXELS) return { exceeded: false };
    const suggested = fitCanvasToH3Limit(w, h);
    const percent = Math.round((pixels / H3_CANVAS_MAX_PIXELS - 1) * 100);
    return {
        exceeded: true,
        suggested,
        message:
            `H3 单次出片的画布上限是 ${H3_CANVAS_MAX_PIXELS.toLocaleString()} 像素（1920×1088），` +
            `当前尺寸 ${w}×${h} = ${pixels.toLocaleString()} 像素，超出 ${percent}%。` +
            `请改到 ${suggested.width}×${suggested.height} 以内，或把尺寸档位降到 1080p。`,
    };
}

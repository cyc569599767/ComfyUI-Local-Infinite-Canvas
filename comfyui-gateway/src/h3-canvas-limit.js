// H3 视频画布的像素上限。
//
// MiniMax H3 有一条硬性约束（见 custom_nodes/minimax-h3-audio-t8/core.py）：
//
//   MAX_PIXELS = 1920 * 1088 = 2,088,960
//
// 超过时 conditioning 节点直接抛：
//   ValueError: Requested canvas has N pixels and exceeds the configured
//   MiniMax H3 reference area of 2,088,960 pixels (1920x1088)
//
// 现场症状：4K 卡片（3840x2160）经 snap32 变成 3840x2176 = 8,355,840 像素，
// 正好是上限的 4 倍，跑到 ComfyUI 才失败，白等一轮 GPU 排队。
//
// 这里在网关入口就拦住，并给出可操作的替代尺寸。

export const H3_MAX_PIXELS = 1920 * 1088;
const STEP = 32;

/** 向上对齐到 32 的倍数（H3 要求宽高可被 32 整除）。 */
export function snap32(value) {
    return Math.max(STEP, Math.round(Number(value) / STEP) * STEP);
}

/** 判断某个尺寸是否超出 H3 的像素上限。 */
export function exceedsH3PixelLimit(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (w <= 0 || h <= 0) return false;
    return w * h > H3_MAX_PIXELS;
}

/**
 * 按原宽高比把尺寸缩到上限内，宽高仍是 32 的倍数。
 *
 * 缩放系数取 sqrt(上限 / 当前像素)，两边同比例缩，比例不变；
 * 缩完再对齐 32 —— 对齐可能略微超过上限，所以最后再校验一轮。
 */
export function fitSizeToH3Limit(width, height) {
    const w = snap32(width);
    const h = snap32(height);
    if (w * h <= H3_MAX_PIXELS) return { width: w, height: h, scaled: false };
    const scale = Math.sqrt(H3_MAX_PIXELS / (w * h));
    let nextW = snap32(w * scale);
    let nextH = snap32(h * scale);
    // 对齐 32 后可能又冒头一点，逐步收到上限内（32 步进，最多几步）。
    while (nextW * nextH > H3_MAX_PIXELS && (nextW > STEP || nextH > STEP)) {
        if (nextW >= nextH) nextW = Math.max(STEP, nextW - STEP);
        else nextH = Math.max(STEP, nextH - STEP);
    }
    return { width: nextW, height: nextH, scaled: true };
}

/** 给用户的错误文案：说清上限、当前值和建议值。 */
export function h3PixelLimitMessage(width, height) {
    const w = snap32(width);
    const h = snap32(height);
    const fit = fitSizeToH3Limit(w, h);
    return (
        `H3 单次出片的画布上限是 ${H3_MAX_PIXELS.toLocaleString()} 像素（1920×1088），` +
        `当前请求 ${w}×${h} = ${(w * h).toLocaleString()} 像素，超出 ${Math.round(((w * h) / H3_MAX_PIXELS - 1) * 100)}%。` +
        `请降到 ${fit.width}×${fit.height} 以内，或改用 1080p 档。`
    );
}

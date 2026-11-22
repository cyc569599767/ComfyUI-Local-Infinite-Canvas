// Viggle Remake 的画布短边选择。
//
// RemakeConditioning 的 short_edge 只允许 480–736（步进 32），且它的行为是：
//   - 源视频短边恰好等于 short_edge、两边都是 32 的倍数 → 原样使用
//   - 否则按 16:9 强行改画布再 cover-crop（832x480 / 1280x736）
//
// 也就是说「想保留源视频的原分辨率和比例」，唯一的办法是让 short_edge 尽量
// 贴近源视频短边，并保证宽高都是 32 的倍数。硬编码 480 会把 1080p 源片
// 压到 854x480 再按 16:9 裁掉两边，竖屏素材被裁得更狠。

export const REMAKE_SHORT_EDGE_MIN = 480;
export const REMAKE_SHORT_EDGE_MAX = 736;
const STEP = 32;

/** 向上对齐到 32 的倍数（Remake 要求两边都是 32 的倍数才原样使用）。 */
export function alignUp32(value) {
    const n = Math.round(Number(value) || 0);
    return Math.ceil(n / STEP) * STEP;
}

/**
 * 按源视频尺寸挑 short_edge。
 *
 * 优先级：能让画布「原样保留」最好（源短边本身就是 32 倍数且在范围内），
 * 否则取尽量大、但不超过源短边的 32 倍数 —— 向上对齐会把 720 抬成 736，
 * 比源片还大，反而触发 16:9 裁剪，画质和比例都更差。
 *
 * - 源短边是 32 倍数且 ≤736 → 直接用（可原样保留）
 * - 否则向下取 32 倍数，再夹到 [480, 736]
 * - 源尺寸未知 → 480（保守，等同旧行为）
 */
export function pickRemakeShortEdge(sourceWidth, sourceHeight) {
    const w = Math.round(Number(sourceWidth) || 0);
    const h = Math.round(Number(sourceHeight) || 0);
    if (w <= 0 || h <= 0) return REMAKE_SHORT_EDGE_MIN;
    const shortSide = Math.min(w, h);
    // 已经是对齐值且在允许范围：原样保留（1280x720 之外的 32 倍数尺寸）
    if (shortSide % STEP === 0 && shortSide >= REMAKE_SHORT_EDGE_MIN && shortSide <= REMAKE_SHORT_EDGE_MAX) return shortSide;
    // 其他情况向下取整，绝不放大到超过源片 —— 放大只会引入插值糊并触发裁剪
    const floored = Math.floor(shortSide / STEP) * STEP;
    return Math.min(REMAKE_SHORT_EDGE_MAX, Math.max(REMAKE_SHORT_EDGE_MIN, floored));
}

/**
 * 图像阶段的画布尺寸。
 *
 * 现场缺陷：这里原来固定 832x480（横屏）。竖屏 1080x1878 的源片被
 * force_original_aspect_ratio=increase + crop 强裁成 832x480，只截到画面
 * 中间约 27% 的高度 —— 正好是胸口领带那一块，人脸完全被裁掉。图像门在
 * 这种「无脸图」上仍然判通过（整幅框下没有框外像素可比），结果送进视频
 * 模型的就是一张领带特写，模型只能凭空编一个新场景。
 *
 * 所以画布必须跟随源片朝向，并按面积预算缩放（长边约 1024² 像素当量，
 * 与 Qwen Image 的训练分辨率一致）。
 */
export const IMAGE_CANVAS_FALLBACK = { width: 832, height: 480 };
const IMAGE_CANVAS_MAX_PIXELS = 1024 * 1024;

/**
 * 按源片朝向算图像画布。
 *
 * 规则：保持源片宽高比，面积贴近预算，两边都向下对齐到 32 的倍数
 * （向下而非向上，保证不超预算、也不会比源片更大）。
 */
export function pickImageCanvas(sourceWidth, sourceHeight) {
    const w = Math.round(Number(sourceWidth) || 0);
    const h = Math.round(Number(sourceHeight) || 0);
    if (w <= 0 || h <= 0) return { ...IMAGE_CANVAS_FALLBACK };
    const aspect = w / h;
    // 由面积预算反解两边，保持源片宽高比：
    //   w' = sqrt(预算 * aspect), h' = sqrt(预算 / aspect)
    // 再向下对齐到 32 —— 向下保证不超预算、也不会比源片更大。
    const alignDown32 = (value) => Math.max(32, Math.floor(Math.round(value) / STEP) * STEP);
    return {
        width: alignDown32(Math.sqrt(IMAGE_CANVAS_MAX_PIXELS * aspect)),
        height: alignDown32(Math.sqrt(IMAGE_CANVAS_MAX_PIXELS / aspect)),
    };
}

/**
 * 算出 RemakeConditioning 实际会用的画布（与它内部逻辑保持一致），
 * 用于在日志/报错里说明「最终出片尺寸」。
 *
 * 当源片短边 == shortEdge 且两边都是 32 的倍数时原样；否则按 16:9 cover-crop。
 */
export function remakeCanvas(sourceWidth, sourceHeight, shortEdge) {
    const w = Math.round(Number(sourceWidth) || 0);
    const h = Math.round(Number(sourceHeight) || 0);
    const se = Math.max(REMAKE_SHORT_EDGE_MIN, Math.min(REMAKE_SHORT_EDGE_MAX, Math.round(Number(shortEdge) || REMAKE_SHORT_EDGE_MIN)));
    if (w <= 0 || h <= 0) return { width: se * 16 / 9 / 32 * 32 || 832, height: se, kept: false };
    if (Math.min(w, h) === se && w % STEP === 0 && h % STEP === 0) {
        return { width: w, height: h, kept: true };
    }
    // 与 nodes.py 相同：long = se * 16 // 9 // 32 * 32
    const long = Math.floor(Math.floor(Math.floor((se * 16) / 9) / 32) * 32);
    return w >= h ? { width: long, height: se, kept: false } : { width: se, height: long, kept: false };
}

// 换人目标区域与提示词。
//
// 现场缺陷：单人物视频（人物居中）跑换人，图像门报「目标未命中/身份或背景保持不足」，
// 且 painted 产物直接是参考图本身。原因是 single_swap 的默认框永远是右半幅
// （x=0.51, w=0.45），而 targetLabel 据此生成「画面右侧人物」—— 画面里根本
// 没有「右侧人物」，模型于是把参考图整个吐了出来。
//
// 单人影的正确默认是「整幅画面」：不知道人物在哪时，让模型在整图里找目标，
// 而不是赌一个半幅框。

/** 单人影的整幅框：覆盖全图，不预设人物位置。 */
export const FULL_FRAME_BOX = { x: 0, y: 0, width: 1, height: 1 };

/** 双人影的左右半幅框（这种模式下确实有两个人，左右分布是合理先验）。 */
export const LEFT_BOX = { x: 0.04, y: 0.03, width: 0.45, height: 0.94 };
export const RIGHT_BOX = { x: 0.51, y: 0.03, width: 0.45, height: 0.94 };

/** 判断框是否覆盖整幅画面。 */
export function isFullFrameBox(box) {
    if (!box) return false;
    const w = Number(box.width) || 0;
    const h = Number(box.height) || 0;
    const x = Number(box.x) || 0;
    const y = Number(box.y) || 0;
    // 允许浮点误差：0.98 以上且起点接近 0 就算整幅
    return x <= 0.02 && y <= 0.02 && w >= 0.96 && h >= 0.96;
}

/**
 * 选默认目标框。
 *
 * - double_swap：左右半幅（确实两个人）
 * - 编辑类（改衣服/光照/时间）：不框选，交给整图理解
 * - single_swap：**整幅画面**。只有在 intent 明确说了「左/右」且没说另一个时，
 *   才收窄到对应半幅 —— 这时用户是明确指定的。
 */
export function defaultTargetBoxes(mode, intent) {
    if (mode === "double_swap") return [LEFT_BOX, RIGHT_BOX];
    if (mode === "edit_clothes" || mode === "edit_light" || mode === "edit_time") return [];
    const text = String(intent || "");
    const mentionsLeft = /左/.test(text);
    const mentionsRight = /右/.test(text);
    // 明确且只提一侧才收窄；两侧都提或都没提，都用整幅
    if (mentionsLeft && !mentionsRight) return [LEFT_BOX];
    if (mentionsRight && !mentionsLeft) return [RIGHT_BOX];
    return [FULL_FRAME_BOX];
}

/**
 * 生成目标区域的自然语言描述。
 *
 * 整幅画面时必须说「画面中的人物」，不能说「画面右侧人物」——
 * 后者会让模型去右边找人，找不到就把参考图吐出来。
 */
export function describeTarget(box) {
    if (!box) return "目标人物";
    if (isFullFrameBox(box)) return "画面中的人物";
    const centerX = (Number(box.x) || 0) + (Number(box.width) || 0) / 2;
    return centerX >= 0.5 ? "画面右侧人物" : "画面左侧人物";
}

/**
 * 单人影换人的提示词。
 *
 * 关键点：
 * 1. 用「画面中的人物」而不是「右侧人物」，与整幅框一致
 * 2. 明确说「以第 1 张参考图为源图、第 2 张为角色参考」，避免模型搞混
 *    （Qwen 的 images.image_1/2 只是并列参考，不写清楚就分不清谁是底图）
 * 3. 去掉「茶具」这类与具体场景绑定的词 —— 通用场景里没有茶具，
 *    反而会让模型困惑或画蛇添足
 */
export function buildSingleSwapPrompt(box) {
    const label = describeTarget(box);
    return (
        `<rwth>, 将第 2 张参考图中${label}替换为第 1 张参考图中的人物；` +
        `严格保持第 1 张参考人物的脸型、五官、发型与服装特征；` +
        `保持原图人物的姿势、动作、位置、尺度与构图不变；` +
        `保持背景、光照、色调与画面细节不变。只替换人物身份，其他区域保持原样。`
    );
}

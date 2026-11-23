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
 * 英文版目标描述，给视频阶段（MiniMax H3）的英文提示词用。
 *
 * 不能把 describeTarget 的中文结果直接拼进英文提示词 —— 会得到
 * "they replace the 画面中的人物 in <Video 1>" 这种中英混杂的句子。
 */
export function describeTargetEn(box) {
    if (!box) return "target person";
    if (isFullFrameBox(box)) return "person in the video";
    const centerX = (Number(box.x) || 0) + (Number(box.width) || 0) / 2;
    return centerX >= 0.5 ? "person on the right" : "person on the left";
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

/**
 * 视频阶段（MiniMax H3）的换人提示词。
 *
 * 放在这里而不是 swap-chain.js，是为了让它可单独测试：
 * 之前它引用了已删除的 targetLabel，任务一路跑到 s5_video（图像门都过了）
 * 才报 ReferenceError，代价最大的一种失败。
 */
export function buildSwapVideoPrompt(job) {
  if (job.mode === "double_swap") {
    return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video showing both replacement people.\n<Subject 1> is the person on the left in <Video 1>, replaced by the left-side person in <Picture 1>.\n<Subject 2> is the person on the right in <Video 1>, replaced by the right-side person in <Picture 1>.\n\nsummary:\n[video editing + character replacement] The target video is an edited version of <Video 1> where the left person becomes <Subject 1> and the right person becomes <Subject 2>, keeping the same actions. Background, props, camera, motion and timing of <Video 1> are kept.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - shot structure, camera path, scene, lighting and action timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - identity and wardrobe for both Subjects.\n<Subject 1> (appears in [Shot 1]): fully_preserved - left figure matches the left side of <Picture 1> throughout.\n<Subject 2> (appears in [Shot 1]): fully_preserved - right figure matches the right side of <Picture 1> throughout.\n\ndetailed_description:\nThe target video matches <Video 1> in scene, colour grade and camera.\n[Shot 1] From 00:00.000 to about 00:05.167, the left person becomes <Subject 1> and the right person becomes <Subject 2>, each following their own body path, poses and timing from <Video 1>. Hair and clothes move naturally. Only these two figures change; everything else stays as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
  }
  const label = describeTargetEn(job.targetBoxes[0]);
  return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video showing the replacement person.\n<Subject 1> is the person in <Picture 1>: they replace the ${label} in <Video 1>. No other person changes.\n\nsummary:\n[video editing + character replacement] The target video is an edited version of <Video 1> where only the ${label} becomes <Subject 1> exactly as in <Picture 1>, keeping the same actions. Background, props, camera, motion and timing of <Video 1> are kept.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - shot structure, camera path, scene, lighting and action timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - identity and wardrobe for <Subject 1> only.\n<Subject 1> (appears in [Shot 1]): fully_preserved - matches <Picture 1> throughout; no leftover original face, hair or clothes.\n\ndetailed_description:\nThe target video matches <Video 1> in scene, colour grade and camera.\n[Shot 1] From 00:00.000 to about 00:05.167, only the ${label} becomes <Subject 1>, following the same body path, poses and timing as <Video 1>. Hair and clothes move naturally. Everything else stays as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
}


/**
 * 视频门的判定逻辑（纯函数，便于单测）。
 *
 * 现场缺陷：第 0 帧是模型的生成起点，天然最接近源片。实测四个采样帧
 * 的 targetDiff 是 [3.82, 32.28, 48.09, 52.07] —— 换人整体成功，
 * 但原实现取「所有帧的最小值」做门槛，3.82 直接判不合格，白白重试一次
 * 视频（每次 10 分钟）。起始帧应当单独记录，不参与硬性门槛。
 */
export function judgeVideoGate({ readings, mode = "", thresholds = {} }) {
    // 这两个数字的分工（实测数据见 swap-chain.js 的 violentAreaRatio 注释）：
    //
    //   maxViolentArea —— 主判据。框内「剧烈改动」的格子占比超过它就判崩坏。
    //     崩坏（整片被重绘成盔甲等）实测 53.8% / 63.8% / 54.3%；
    //     正常换人（只改脸）实测 4.3% / 9.2%。取 30% 两侧都有充足余量。
    //
    //   minMid —— 只用来兜「完全没动」的下限，不再是质量闸门。
    //     原来它当质量阈值用（6），方向是错的：崩坏改动大分数高反而通过，
    //     好换人改动小分数低反被拦。两份内容几乎相同的崩坏视频
    //     （0d35 得分 3.82 被拦、76628068 得分 32.31 放行）就是这么来的。
    const minMid = thresholds.minMid ?? 2;
    const maxViolentArea = thresholds.maxViolentArea ?? 30;
    const maxOutside = thresholds.maxOutside ?? 60;
    const minLuma = thresholds.minLuma ?? 8;
    const list = Array.isArray(readings) ? readings : [];
    if (!list.length) {
        return {
            targetMin: 0,
            startDiff: 0,
            outsideMax: 0,
            backgroundMax: 0,
            lumaMin: 0,
            violentAreaMax: 0,
            targetOk: false,
            structureOk: false,
            backgroundOk: false,
            blackOk: false,
            pass: false,
        };
    }
    const startDiff = Number(list[0].targetDiff) || 0;
    const mid = list.slice(1);
    const targetMin = mid.length
        ? Math.min(...mid.map((item) => Number(item.targetDiff) || 0))
        : Math.min(...list.map((item) => Number(item.targetDiff) || 0));
    const outsideMax = Math.max(...list.map((item) => Number(item.outsideDiff) || 0));
    // 背景只看前半段：后半段模型可能在合法地改变场景光效。
    const early = list.filter((item) => Number(item.frame) < 80);
    const backgroundMax = early.length
        ? Math.max(...early.map((item) => Number(item.outsideDiff) || 0))
        : outsideMax;
    const lumaMin = Math.min(...list.map((item) => Number(item.luma) || 0));
    const editTime = mode === "edit_time" || mode === "edit_light";
    const targetOk = targetMin > minMid;
    // 崩坏判据：取各采样帧里最大的剧烈改动面积（任一帧崩了就算崩）。
    const violentAreas = list.map((item) => Number(item.violentArea)).filter((v) => Number.isFinite(v));
    const violentAreaMax = violentAreas.length ? Math.max(...violentAreas) : 0;
    const structureOk = violentAreaMax <= maxViolentArea;
    const backgroundOk = editTime ? true : backgroundMax < maxOutside;
    const blackOk = lumaMin > minLuma;
    return {
        targetMin: Number(targetMin.toFixed(2)),
        startDiff: Number(startDiff.toFixed(2)),
        outsideMax: Number(outsideMax.toFixed(2)),
        backgroundMax: Number(backgroundMax.toFixed(2)),
        violentAreaMax: Number(violentAreaMax.toFixed(1)),
        lumaMin: Number(lumaMin.toFixed(1)),
        targetOk,
        structureOk,
        backgroundOk,
        blackOk,
        pass: targetOk && structureOk && backgroundOk && blackOk,
    };
}

/**
 * 从 ComfyUI /queue 的返回里判断某个 prompt 是否还活着。
 *
 * 用途：waitPrompt 查不到历史记录时要区分「还在排队/执行」与「已经被丢了」。
 * 现场踩过：ComfyUI 长时间运行后 /view 劣化，任务其实早已结束，网关却一直
 * 空转到超时，用户只能干等 20 分钟。
 *
 * 队列项结构是 [number, prompt_id, prompt, extra_data, outputs]。
 * 查不到队列信息（接口异常）时返回 true —— 宁可继续等，也不要误判任务丢失。
 */
export function isPromptInQueue(queueData, promptId) {
    if (!queueData || typeof queueData !== "object") return true;
    const target = String(promptId ?? "");
    if (!target) return true;
    // 两个字段都不是数组（包括双双缺失）→ 接口结构不是我们认识的 /queue 格式，
    // 按「未知」处理（继续等）。误判任务丢失的代价是白白中断一次十几分钟的生成，
    // 而多等一分钟几乎没有代价。
    const rawRunning = queueData.queue_running;
    const rawPending = queueData.queue_pending;
    if (!Array.isArray(rawRunning) && !Array.isArray(rawPending)) return true;
    const running = Array.isArray(rawRunning) ? rawRunning : [];
    const pending = Array.isArray(rawPending) ? rawPending : [];
    return [...running, ...pending].some((item) => {
        if (!Array.isArray(item)) return false;
        return String(item[1]) === target;
    });
}

/**
 * 逐像素相关性：判断「是不是同一张构图」。
 *
 * 与直方图相关性的关键区别：直方图只看颜色分布，不看空间位置。
 * 现场事故：模型把「西装男近景」重画成「古风人物在海面旋涡中施法」，
 * 两者都是低饱和冷色调 —— 直方图相关 0.7807（被判成结构保持），
 * 逐像素相关只有 0.3658（构图其实早就崩了）。
 */
export function pixelCorrelation(a, b) {
    const n = Math.min(a?.length || 0, b?.length || 0);
    if (!n) return 0;
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < n; i += 1) {
        meanA += a[i];
        meanB += b[i];
    }
    meanA /= n;
    meanB /= n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i += 1) {
        const x = a[i] - meanA;
        const y = b[i] - meanB;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * 「有没有真的改动」——必须看局部峰值，不能看整图平均。
 *
 * 换人本质上是局部改动：脸在整幅画面里只占十几个百分点。
 * 现场实测（男孩换成年男性，脸已完全换掉）：
 *   整图平均差异 5.47  → 低于旧阈值 7，被判「没换」
 *   前 5% 格子均值 54.33、最大单格 185.67 → 改动其实非常显著
 * 用整图平均衡量，等于把「脸换了」这件事按面积稀释掉，必然误杀。
 *
 * 采用两个口径取其一（满足任一即算改过）：
 *   · 局部峰值 peakDiff 超过阈值（局部改动，如换脸）
 *   · 整图平均 avgDiff 超过阈值（整片改动，如换装/换场景）
 * 两者都设下限，避免「只动了一两个像素」也算通过。
 */
export function judgeChanged({ peakDiff = 0, avgDiff = 0, maxDiff = 0, thresholds = {} }) {
    // 三个口径，满足其一即算「真的改了」，因为不同路径的改动形态差别很大：
    //
    //   · avgDiff  — 整片改动（换装/换场景）：差异摊在全图
    //   · peakDiff — 局部重绘（Qwen 全图重绘式换脸）：实测前 5% 均值 54 左右
    //   · maxDiff  — 精细换脸（ReActor/inswapper）：只动五官纹理，
    //                实测前 5% 均值仅 11.61、但最大单格 23.67、差异>10 的格子占 3%
    //
    // 只卡 peakDiff>18 会把 ReActor 的正常换脸全部误杀（脸明明换了，
    // 只是改动面积小、幅度细）。所以给 maxDiff 留一条下限 18。
    const minPeak = thresholds.minPeak ?? 18;
    const minAvg = thresholds.minAvg ?? 7;
    const minMax = thresholds.minMax ?? 18;
    const peakOk = Number(peakDiff) > minPeak;
    const avgOk = Number(avgDiff) > minAvg;
    const maxOk = Number(maxDiff) > minMax;
    return { changedOk: peakOk || avgOk || maxOk, peakOk, avgOk, maxOk };
}

/**
 * 图像门判定（纯函数）。
 *
 * 整幅框时「框外」是空集合，outsideDiff 恒为 0，必须靠结构相关性兜底；
 * 而结构相关性必须用逐像素口径，否则整图重画也能过（见 pixelCorrelation）。
 *
 * targetDiff 传入整图平均，peakDiff 传入局部峰值（前 5% 格子均值）。
 * 只传 targetDiff 时退回旧行为，便于兼容既有调用。
 */
export function judgeImageGate({ outsideDiff = 0, targetDiff = 0, peakDiff = null, maxDiff = null, structureCorr = 1, fullFrame = false, mode = "", identity = [], thresholds = {} }) {
    const minStructure = thresholds.minStructure ?? 0.55;
    const maxOutside = thresholds.maxOutside ?? 40;
    const maxOutsideEdit = thresholds.maxOutsideEdit ?? 55;
    const isEdit = String(mode || "").startsWith("edit_");
    const editLightTime = mode === "edit_light" || mode === "edit_time";
    const outsideOk = editLightTime
        ? true
        : isEdit
            ? outsideDiff < maxOutsideEdit
            : fullFrame
                ? structureCorr > minStructure
                : outsideDiff < maxOutside;
    // 有局部峰值就用它判定，否则退回整图平均 + 旧阈值。
    const changed = peakDiff === null || peakDiff === undefined
        ? { changedOk: targetDiff > (thresholds.minChanged ?? 7) }
        : judgeChanged({ peakDiff, avgDiff: targetDiff, maxDiff: maxDiff ?? 0, thresholds });
    const identityOk = !identity.length || identity.every((item) => item.hit);
    return {
        outsideOk,
        changedOk: changed.changedOk,
        peakOk: changed.peakOk,
        avgOk: changed.avgOk,
        maxOk: changed.maxOk ?? null,
        identityOk,
        pass: changed.changedOk && outsideOk && identityOk,
    };
}

/**
 * 「是否保留原片服装」的可行性判定（纯函数）。
 *
 * 三种结果：
 *   active      —— 走 ReActor 逐帧换脸，只换脸、其他全部沿用原片
 *   conflict    —— 用户既要保留服装又要换装，语义互斥，必须报错
 *   fallback    —— 当前模式不支持（如双人替换），回退整体重绘，需告知用户
 *
 * 为什么不静默择一执行：回退会让用户拿到与预期相反的结果
 * （想保留服装，却看到参考图的衣服被带过来）。
 */
export function resolveKeepClothes({ keepClothes = false, mode = "", refCount = 0 } = {}) {
  if (!keepClothes) return { state: "off", active: false, reason: "" };
  if (mode === "edit_clothes") {
    return {
      state: "conflict",
      active: false,
      reason: "「保留原片服装」与「换装」是互相冲突的两个要求，请只选一个",
    };
  }
  if (mode !== "single_swap") {
    return {
      state: "fallback",
      active: false,
      reason: mode === "double_swap"
        ? "双人替换不支持保留服装（需要同时重绘两个人的身体），本次已回退到整体重绘"
        : "当前模式不支持保留服装，本次已回退到整体重绘",
    };
  }
  if (Number(refCount) <= 0) {
    return { state: "fallback", active: false, reason: "换人需要至少 1 张参考图，本次已回退到整体重绘" };
  }
  return { state: "active", active: true, reason: "" };
}

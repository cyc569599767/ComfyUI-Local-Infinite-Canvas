import { expect, test } from "bun:test";
import {
    elasticPackShots,
    estimateShotSeconds,
    expandShotsForVideo,
    fallbackBeatsFromScript,
    fallbackShotPlan,
    looksLikeH3Prompt,
    normalizeBeats,
    normalizeH3Prompt,
    normalizeShotPlan,
    parseDialogueLines,
    planToShots,
    repairStoryboardPlan,
    serializeDialogueLines,
    validateStoryboardPlan,
} from "../src/lib/short-drama/storyboard";
import type { CanvasDramaStoryboardShot, DramaBeat, DramaShotPlan } from "../src/types/canvas";

const shot = (patch: Partial<CanvasDramaStoryboardShot> = {}): CanvasDramaStoryboardShot => ({
    shotNumber: 1,
    title: "镜头",
    segmentIndex: 0,
    segmentTitle: "第一段",
    location: "萧家广场",
    time: "清晨",
    shotType: "全景",
    cameraAngle: "平视",
    cameraMovement: "static",
    lightingStyle: "自然光",
    depthOfField: "中",
    action: "站在广场中央",
    result: "转身离开",
    dialogue: "",
    emotion: "平静",
    emotionIntensity: 1,
    ...patch,
});

const planShot = (patch: Partial<DramaShotPlan> = {}): DramaShotPlan => ({
    id: "s1",
    beatIds: ["b1"],
    segmentIndex: 0,
    segmentTitle: "",
    location: "萧家广场",
    time: "清晨",
    duration: 6,
    shotType: "MS",
    cameraAngle: "eye level",
    cameraMovement: "static",
    lightingStyle: "natural",
    depthOfField: "medium",
    action: "站在广场中央",
    result: "转身离开",
    dialogue: [],
    emotion: "平静",
    emotionIntensity: 0,
    ...patch,
});

test("时长按 4.5 字/秒估算并夹在 2–25 秒", () => {
    // 4 字台词：4/4.5+0.4=1.29，加 0.5 气口取整=2 → 触底 2 秒。
    expect(estimateShotSeconds(shot({ dialogue: "你来了。" }))).toBe(3);
    // 12 字台词：12/4.5+0.4=3.07，+0.5 → 4 秒。
    expect(estimateShotSeconds(shot({ dialogue: "纳兰嫣然当众退婚让人哗然" }))).toBe(4);
    // 动作侧有 2 秒下限兜底，所以即使无台词无长动作也落在 3 秒而不是 0。
    expect(estimateShotSeconds(shot({ action: "", result: "" }))).toBe(3);
});

test("LLM 给的 duration 只能向下修，不能抬长", () => {
    const base = shot({ dialogue: "纳兰嫣然当众退婚让人哗然" });
    expect(estimateShotSeconds({ ...base, duration: 3 })).toBe(3);
    // 内容只值 4 秒，LLM 写 20 秒也不能撑长。
    expect(estimateShotSeconds({ ...base, duration: 20 })).toBe(4);
});

test("动作时长按信息量连续估算，不压成固定 3 秒", () => {
    expect(estimateShotSeconds(shot({ action: "A".repeat(60), dialogue: "" }))).toBe(7);
    const short = estimateShotSeconds(shot({ action: "抬手", dialogue: "" }));
    const long = estimateShotSeconds(shot({ action: "抬" .repeat(80), dialogue: "" }));
    expect(long).toBeGreaterThan(short);
});

test("超长镜头按 15 秒切分且重编镜号不丢内容", () => {
    // 多个切镜 + 多句台词，内容确实装不进一段时必须拆开。
    const cutAction = Array.from({ length: 8 }, (_, i) => `${"动作描述".repeat(12)} Cut to Shot ${i + 1}`).join(" ");
    const longDialogue = Array.from({ length: 8 }, (_, i) => `第${i + 1}句台词内容稍长一些`).join("\n");
    const expanded = expandShotsForVideo([shot({ action: cutAction, dialogue: longDialogue })], 15);
    expect(expanded.length).toBeGreaterThan(1);
    // 镜号必须连续从 1 开始重排，否则画布卡片顺序会错。
    expect(expanded.map((item) => item.shotNumber)).toEqual(expanded.map((_, index) => index + 1));
    // 每段都不能超 25 秒硬上限。
    expect(expanded.every((item) => (item.duration || 0) <= 25)).toBe(true);
    // 拆分后内容不能丢：动作与台词都要保留在某个段里。
    expect(expanded.map((item) => item.dialogue).join("\n")).toContain("第1句台词");
    expect(expanded.map((item) => item.action).join("")).toContain("动作描述");
    // 拆出来的每一段都要有台词，不能出现白烧生成的空卡。
    expect(expanded.every((item) => item.dialogue.trim() || !item.action.trim())).toBe(true);
});

test("内容装得进一段时不拆，避免无意义地多花一次生成", () => {
    // 单个动作 part（12s 上限）+ 台词总量未超段长，整段保留即可。
    const single = expandShotsForVideo([shot({ action: "A".repeat(200), dialogue: "这句话很长".repeat(20) })], 15);
    expect(single).toHaveLength(1);
    expect(single[0].dialogue.trim().length).toBeGreaterThan(0);
    expect((single[0].duration || 0) <= 25).toBe(true);
});

test("同场景短镜打包成 ≤15 秒生成段，内部记录切点", () => {
    const packed = elasticPackShots([shot({ action: "走近", dialogue: "你来了。" }), shot({ action: "回头", dialogue: "我等你很久。" })], 15);
    expect(packed).toHaveLength(1);
    expect(packed[0].duration).toBe(6);
    expect(packed[0].start).toBe(0);
    expect(packed[0].end).toBe(6);
    // 合并后动作与台词都要保留，且内部切点写成 At 00:0X.000。
    expect(packed[0].action).toBe("走近；回头");
    expect(packed[0].dialogue).toContain("你来了。");
    expect(packed[0].dialogue).toContain("我等你很久。");
    expect(packed[0].cutPoints).toEqual(["At 00:03.000"]);
});

test("跨场景或跨段落不合并，时间轴连续累加", () => {
    const cross = elasticPackShots([shot({ action: "走近", location: "广场" }), shot({ action: "回头", location: "屋内" })], 15);
    expect(cross).toHaveLength(2);
    expect(cross[1].start).toBe(cross[0].end);
    const segDiff = elasticPackShots([shot({ action: "a", segmentIndex: 0 }), shot({ action: "b", segmentIndex: 1 })], 15);
    expect(segDiff).toHaveLength(2);
});

test("打包后总时长等于各段之和，不会因合并而漂移", () => {
    const shots = [shot({ action: "a", dialogue: "一二三" }), shot({ action: "b", dialogue: "四五六" }), shot({ action: "c", location: "别处" })];
    const packed = elasticPackShots(shots, 15);
    const total = packed.reduce((sum, item) => sum + (item.duration || 0), 0);
    expect(packed[packed.length - 1].end).toBe(total);
    expect(packed[0].start).toBe(0);
});

test("台词逐行解析通道、说话人与正文", () => {
    expect(parseDialogueLines("[内心] 萧炎：我该怎么办")).toEqual([{ speaker: "萧炎", channel: "inner", text: "我该怎么办" }]);
    expect(parseDialogueLines("[画外] 系统：门被推开")).toEqual([{ speaker: "系统", channel: "system", text: "门被推开" }]);
    expect(parseDialogueLines("萧炎：你来了")).toEqual([{ speaker: "萧炎", channel: "spoken", text: "你来了" }]);
    expect(parseDialogueLines("你来了")).toEqual([{ speaker: "角色", channel: "spoken", text: "你来了" }]);
    expect(parseDialogueLines("")).toEqual([]);
});

test("无说话人的通道台词按通道保底，不被静默丢弃", () => {
    // 只有通道标签、没有「说话人：」时，整段都是台词，说话人取该通道的默认值。
    expect(parseDialogueLines("[内心]我不能退")).toEqual([{ speaker: "角色", channel: "inner", text: "我不能退" }]);
    expect(parseDialogueLines("[画外]门被推开")).toEqual([{ speaker: "系统", channel: "system", text: "门被推开" }]);
    expect(parseDialogueLines("[系统]叮！获得传承")).toEqual([{ speaker: "系统", channel: "system", text: "叮！获得传承" }]);
    expect(parseDialogueLines("[台词]你好")).toEqual([{ speaker: "角色", channel: "spoken", text: "你好" }]);
    // 多行混合时不能因为某行没说话人就整行消失。
    expect(parseDialogueLines("[内心]我不能退\n萧炎：你来了")).toEqual([
        { speaker: "角色", channel: "inner", text: "我不能退" },
        { speaker: "萧炎", channel: "spoken", text: "你来了" },
    ]);
});

test("台词正文里的冒号不被误判成说话人", () => {
    // 人称代词起头的冒号属于台词正文。
    expect(parseDialogueLines("[内心] 我想：他来了")).toEqual([{ speaker: "角色", channel: "inner", text: "我想：他来了" }]);
    expect(parseDialogueLines("[台词]他说：我不去")).toEqual([{ speaker: "角色", channel: "spoken", text: "他说：我不去" }]);
    // 真正的说话人仍要正确拆出（含英文冒号、带空格的写法）。
    expect(parseDialogueLines("[台词] 萧炎: 你来了")).toEqual([{ speaker: "萧炎", channel: "spoken", text: "你来了" }]);
    expect(parseDialogueLines("[内心]纳兰嫣然：我不会退")).toEqual([{ speaker: "纳兰嫣然", channel: "inner", text: "我不会退" }]);
    // 画外音允许写来源（广播/电视）。
    expect(parseDialogueLines("[画外]广播：三百万金币")).toEqual([{ speaker: "广播", channel: "system", text: "三百万金币" }]);
});

test("台词序列化与解析可往返，通道不丢失", () => {
    const lines = [
        { speaker: "萧炎", channel: "inner" as const, text: "我该怎么办" },
        { speaker: "纳兰嫣然", channel: "spoken" as const, text: "你来了" },
        { speaker: "系统", channel: "system" as const, text: "叮" },
    ];
    const text = serializeDialogueLines(lines);
    expect(text).toBe("[内心] 萧炎：我该怎么办\n[台词] 纳兰嫣然：你来了\n[画外] 系统：叮");
    expect(parseDialogueLines(text)).toEqual(lines);
});

test("超长单句 inner 整段保留，不拆出无台词空段", () => {
    // 单句内心 + 无动作切镜属于不可切割内容：整段保留并夹到 25s，
    // 不能先产出一张「只有动作没有台词」的空卡再补一张整段卡。
    const expanded = expandShotsForVideo([shot({ action: "静坐", dialogue: `[内心] 萧炎：${"很长的一句话".repeat(20)}` })], 15);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].dialogue).toContain("[内心]");
    expect((expanded[0].duration || 0)).toBeLessThanOrEqual(25);
    expect(expanded[0].splitReason).toBe("单句超长/不可切，按整段保留");
});

test("校验能发现 beat 漏覆盖、重复覆盖与时长装不下台词", () => {
    const beats: DramaBeat[] = [
        { id: "b1", type: "action", key: false, location: "", time: "", summary: "走进广场", estSeconds: 2 },
        { id: "b2", type: "dialogue", key: false, location: "", time: "", summary: "我来了", speaker: "萧炎", text: "我来了", estSeconds: 2 },
    ];
    const missed = validateStoryboardPlan([planShot({ beatIds: ["b1"] })], beats);
    expect(missed.ok).toBe(false);
    expect(missed.errors.some((error) => error.includes("b2 未被覆盖"))).toBe(true);

    const duplicated = validateStoryboardPlan([planShot({ beatIds: ["b1", "b2"] }), planShot({ id: "s2", beatIds: ["b1"] })], beats);
    expect(duplicated.errors.some((error) => error.includes("重复覆盖"))).toBe(true);

    // 30 字台词需要约 7 秒，给 4 秒必须报错。
    const tooShort = validateStoryboardPlan([planShot({ beatIds: ["b1", "b2"], duration: 4, dialogue: [{ speaker: "萧炎", channel: "spoken", text: "这".repeat(30) }] })], [beats[1]]);
    expect(tooShort.errors.some((error) => error.includes("装不下"))).toBe(true);

    const unknownBeat = validateStoryboardPlan([planShot({ beatIds: ["b1", "b9"] })], beats);
    expect(unknownBeat.errors.some((error) => error.includes("未知 beat b9"))).toBe(true);
});

test("校验对非 static 运镜缺理由、缺连续性字段给警告而非错误", () => {
    const beats: DramaBeat[] = [{ id: "b1", type: "action", key: false, location: "", time: "", summary: "走", estSeconds: 2 }];
    const result = validateStoryboardPlan([planShot({ beatIds: ["b1"], cameraMovement: "push" })], beats);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("camera_purpose"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("entry_state"))).toBe(true);
    // static 镜不需要运镜叙事理由。
    expect(validateStoryboardPlan([planShot({ beatIds: ["b1"] })], beats).warnings.some((warning) => warning.includes("camera_purpose"))).toBe(false);
});

test("超段长但给了切点或拆分理由时不再报错", () => {
    const beats: DramaBeat[] = [{ id: "b1", type: "action", key: false, location: "", time: "", summary: "走", estSeconds: 2 }];
    const withCut = validateStoryboardPlan([planShot({ beatIds: ["b1"], duration: 18, cutPoints: ["At 00:09.000"] })], beats);
    expect(withCut.errors).toEqual([]);
    const withReason = validateStoryboardPlan([planShot({ beatIds: ["b1"], duration: 18, splitReason: "连续动作不可切" })], beats);
    expect(withReason.errors).toEqual([]);
    // 既没切点也没理由必须拦下。
    const bare = validateStoryboardPlan([planShot({ beatIds: ["b1"], duration: 18 })], beats);
    expect(bare.errors.some((error) => error.includes("没有切点或拆分理由"))).toBe(true);
});

test("beat 归一化把旁白/画外降级，并合并连续 inner", () => {
    const beats = normalizeBeats([
        { id: "b1", type: "narration", text: "叙述旁白" },
        { id: "b2", type: "inner", speaker: "萧炎", text: "我不能退", location: "广场" },
        { id: "b3", type: "inner", speaker: "萧炎", text: "绝不", location: "广场" },
    ]);
    // narration/voiceover 不是合法通道，按规则降级为 action。
    expect(beats[0].type).toBe("action");
    // 同说话人同场景的连续 inner 合并成一条，避免一镜塞满内心。
    expect(beats).toHaveLength(2);
    expect(beats[1].type).toBe("inner");
    expect(beats[1].summary).toBe("我不能退；绝不");
});

test("beat 归一化给缺失 id 补号并去重，估计时长夹在 1–12", () => {
    const beats = normalizeBeats([{ type: "action", text: "走" }, { id: "b1", type: "action", text: "停" }]);
    expect(beats.map((beat) => beat.id)).toEqual(["b1", "b1-2"]);
    expect(beats.every((beat) => beat.estSeconds >= 1 && beat.estSeconds <= 12)).toBe(true);
    // 没有 summary 和 text 的空 beat 要丢弃，避免生成无内容镜头。
    expect(normalizeBeats([{ type: "action" }, { type: "action", text: "有内容" }])).toHaveLength(1);
});

test("从剧本兜底拆 beat：引号台词识别为 dialogue，动作归并", () => {
    const beats = fallbackBeatsFromScript("他转身。“我不能退。”\n门被推开。");
    const dialogue = beats.filter((beat) => beat.type === "dialogue");
    expect(dialogue).toHaveLength(1);
    expect(dialogue[0].text).toBe("我不能退。");
    expect(dialogue[0].speaker).toBe("角色");
    // 动作段落合并成 action，不逐句散成多个 beat。
    expect(beats.filter((beat) => beat.type === "action").length).toBeGreaterThanOrEqual(1);
});

test.failing("中文全角引号与冒号台词都能被兜底识别（已知缺陷）", () => {
    // 现状：fallbackBeatsFromScript 只认 “...”，且把「萧炎：我不能退」整句当动作。
    // 影响：LLM 不可用时的兜底分镜会漏掉台词，只剩动作卡。
    const beats = fallbackBeatsFromScript("萧炎：我不能退。\n他转身离开。");
    expect(beats.some((beat) => beat.type === "dialogue" && beat.text === "我不能退。")).toBe(true);
});

test("兜底分镜计划覆盖全部 beat 且能通过校验", () => {
    const beats = normalizeBeats([
        { id: "b1", type: "action", text: "走进广场" },
        { id: "b2", type: "dialogue", speaker: "萧炎", text: "我来了" },
    ]);
    const plan = fallbackShotPlan(beats, 15);
    expect(plan.length).toBeGreaterThanOrEqual(1);
    const covered = plan.flatMap((item) => item.beatIds);
    expect(covered).toEqual(["b1", "b2"]);
    expect(validateStoryboardPlan(plan, beats, 15).errors).toEqual([]);
});

test("分镜计划归一化：缺字段补默认，空镜头丢弃，连续内心合并", () => {
    const beats: DramaBeat[] = [{ id: "b1", type: "action", key: false, location: "", time: "", summary: "走", estSeconds: 2 }];
    const plan = normalizeShotPlan(
        {
            shots: [
                { id: "s1", beat_ids: ["b1"], action: "走", dialogue: [{ speaker: "萧炎", channel: "inner", text: "一" }], duration: 6 },
                { id: "s2", beat_ids: ["b1"], action: "走", dialogue: [{ speaker: "萧炎", channel: "inner", text: "二" }], duration: 6 },
                { id: "s3", beat_ids: [], action: "", result: "", dialogue: [] },
            ],
        },
        beats,
    );
    // 两条同说话人同动作、合计 12 秒的连续 inner 合并成一镜。
    expect(plan).toHaveLength(1);
    expect(plan[0].duration).toBe(12);
    expect(plan[0].dialogue.map((line) => line.text)).toEqual(["一", "二"]);
    // 完全没有动作/结果/台词的镜头被丢弃。
    expect(normalizeShotPlan({ shots: [{ id: "x" }] }, beats)).toEqual([]);
    // 超长时长夹到 25 秒上限；夹到上限后不再满足合并条件的镜头保持独立。
    expect(normalizeShotPlan({ shots: [{ id: "s1", beat_ids: ["b1"], action: "走", duration: 100 }] }, beats)[0].duration).toBe(25);
});

test("计划转分镜卡保留镜号顺序与台词文本", () => {
    const shots = planToShots([planShot({ dialogue: [{ speaker: "萧炎", channel: "spoken", text: "你来了" }] })]);
    expect(shots[0].shotNumber).toBe(1);
    expect(shots[0].dialogue).toBe("[台词] 萧炎：你来了");
});

test("修复计划按台词秒数补齐时长，超段长才标注原因", () => {
    const repaired = repairStoryboardPlan([planShot({ duration: 3, dialogue: [{ speaker: "萧炎", channel: "spoken", text: "这".repeat(80) }] })], 15);
    // 80 字 / 4.5 = 17.8 秒，+0.5 气口后向上取整 = 19 秒。
    expect(repaired[0].duration).toBe(19);
    // 19 > 15 段长，且没有现成理由时补上「台词时长需要」。
    expect(repaired[0].splitReason).toBe("台词时长需要，按连续镜头保留");
    // 30 字只需 8 秒，未超 15 秒，不该加拆分理由。
    const short = repairStoryboardPlan([planShot({ duration: 3, dialogue: [{ speaker: "萧炎", channel: "spoken", text: "这".repeat(30) }] })], 15);
    expect(short[0].duration).toBe(8);
    expect(short[0].splitReason).toBeUndefined();
    // 时长已足够时不上调也不改原因。
    const enough = repairStoryboardPlan([planShot({ duration: 10, dialogue: [{ speaker: "萧炎", channel: "spoken", text: "短" }] })], 15);
    expect(enough[0].duration).toBe(10);
    expect(enough[0].splitReason).toBeUndefined();
});

test("H3 提示词识别与规整：缺段补全、越界图片号拒绝、垃圾输入拒绝", () => {
    const valid = `subject_definitions:
<Picture 1>: 萧炎 (costume, colors and accessories match this picture)

summary: A single continuous cinematic shot in 国风。

retention_analysis: Keep every subject's face identical.

detailed_description: 他站着。

overall_soundscape: 风声。

non_diegetic_music: N/A`;
    expect(looksLikeH3Prompt(valid)).toBe(true);
    expect(normalizeH3Prompt(valid, "reference", 1)).toContain("subject_definitions");

    // 引用不存在的图片号必须整段拒绝，不能发出错误参考编号。
    expect(normalizeH3Prompt(valid.replace("<Picture 1>", "<Picture 5>"), "reference", 1)).toBe("");
    // 完全无关的文本不能被当成提示词。
    expect(normalizeH3Prompt("随便一段话", "reference", 0)).toBe("");
    expect(normalizeH3Prompt("", "reference", 0)).toBe("");
    // 首尾帧模式要求 integrated_multimodal_description，缺了就拒绝。
    expect(normalizeH3Prompt(valid, "frames", 1)).toBe("");
});
// 「单集 3 镜」最小链路测试。
//
// 目标：在没有 GPU / 模型的环境下，验证短剧编排链**真实代码路径**能否跑通。
// 做法：把模型响应替换成可控桩（固定 JSON），其余全部调用产品真实函数——
// 与 page.tsx 的编排顺序完全一致：
//   剧本 → normalizeScreenplay → beats
//        → normalizeShotPlan → validateStoryboardPlan → repairStoryboardPlan
//        → planToShots → elasticPackShots → sanityCheckPackedShots
//        → 建分镜卡 → buildDramaResumePlan → buildRef2VAPrompt / ensureSpokenDialogue
// 只有「打模型 HTTP」这一步是桩，因此任何字段契约、校验规则、续跑决策的问题都会暴露。
import { expect, test } from "bun:test";
import {
    buildRef2VAPrompt,
    buildScreenplayAdaptationMessages,
    buildShotPlanMessages,
    elasticPackShots,
    estimateShotSeconds,
    normalizeBeats,
    normalizeH3Prompt,
    normalizeScreenplay,
    normalizeShotPlan,
    parseDialogueLines,
    planToShots,
    repairStoryboardPlan,
    sanityCheckPackedShots,
    validateStoryboardPlan,
} from "../src/lib/short-drama/storyboard";
import { buildDramaResumePlan, createDramaRun, markDramaRunStoryboardsDone } from "../src/lib/short-drama/run-manifest";
import type { CanvasNodeData, DramaBeat, DramaShotPlan } from "../src/types/canvas";

// ---- 单集剧本（3 个镜头量） ----
const EPISODE_SCRIPT = `药老苏醒

萧炎在山洞中打坐，戒指忽然亮起，一道苍老的声音传来：“小子，你我有缘。”
萧炎猛地睁眼，四下无人。
[内心]萧炎：这声音…来自戒指里的灵魂？`;

// ---- 桩 1：剧本改写结果（严格按 SCREENPLAY_ADAPTATION_SYSTEM 的输出契约） ----
// scenes 用 heading 描述地点·时间；beats 用 action + dialogue + source_unit_ids；
// source_quote 必须是原文原句，否则 normalizeScreenplay 会给「不在原文」警告。
const SCREENPLAY_STUB = {
    level: "performance",
    logline: "药老在戒指中苏醒，与萧炎建立联系",
    scenes: [{ id: "s1", heading: "山洞·夜·内", description: "昏暗山洞，石壁潮湿，中央一块平整石台" }],
    source_units: [
        { id: "u1", text: "萧炎在山洞中打坐", kind: "event", epistemic: "fact", required: true },
        { id: "u2", text: "戒指忽然亮起，一道苍老的声音传来", kind: "event", epistemic: "fact", required: true },
        { id: "u3", text: "萧炎猛地睁眼，四下无人", kind: "event", epistemic: "fact", required: true },
    ],
    beats: [
        {
            id: "e1",
            scene_id: "s1",
            action: "萧炎盘腿坐在洞中石台上，双手结印，呼吸均匀",
            source_quote: "萧炎在山洞中打坐",
            source_unit_ids: ["u1"],
            dialogue: [],
        },
        {
            id: "e2",
            scene_id: "s1",
            action: "他手上的古旧戒指开始发出微光，光芒逐渐脉动",
            source_quote: "戒指忽然亮起",
            source_unit_ids: ["u2"],
            dialogue: [],
        },
        {
            id: "e3",
            scene_id: "s1",
            action: "戒指光芒一亮，洞中回响起苍老的声音",
            source_quote: "一道苍老的声音传来",
            source_unit_ids: ["u2"],
            dialogue: [{ speaker: "药老", channel: "spoken", text: "小子，你我有缘" }],
        },
        {
            id: "e4",
            scene_id: "s1",
            action: "萧炎猛地睁开双眼，迅速环顾四周，洞中空无一人",
            source_quote: "萧炎猛地睁眼，四下无人",
            source_unit_ids: ["u3"],
            dialogue: [{ speaker: "萧炎", channel: "inner", text: "这声音来自戒指里的灵魂" }],
        },
    ],
};

// ---- 桩 2：分镜规划结果（3 个镜头，覆盖全部 6 个 beat） ----
// beat_ids 必须是 normalizeScreenplay 展开后的实际 id（动作带 -a、台词带 -d1）。
const SHOT_PLAN_STUB = {
    shots: [
        {
            id: "s1",
            beat_ids: ["e1-a", "e2-a"],
            segment_index: 0,
            segment_title: "苏醒",
            location: "山洞",
            time: "夜",
            duration: 5,
            shot_type: "MS",
            camera_angle: "eye level",
            camera_movement: "static",
            lighting_style: "night",
            depth_of_field: "medium",
            action: "萧炎盘腿坐在洞中石台上，双手结印；他手上的古旧戒指开始发出微光",
            result: "戒指光芒逐渐脉动",
            dialogue: [],
            emotion: "平静",
            emotion_intensity: 0,
            entry_state: "萧炎盘坐于洞中石台，双手结印",
            exit_state: "戒指亮起微光，萧炎仍未睁眼",
        },
        {
            id: "s2",
            beat_ids: ["e3-a", "e3-d1"],
            segment_index: 0,
            segment_title: "苏醒",
            location: "山洞",
            time: "夜",
            duration: 5,
            shot_type: "CU",
            camera_angle: "eye level",
            camera_movement: "push",
            camera_purpose: "把注意力收束到戒指，强调声音来源",
            lighting_style: "night",
            depth_of_field: "shallow",
            action: "戒指出现在画面中心，光芒脉动，洞中回响起苍老的声音",
            result: "苍老的声音落在洞中",
            dialogue: [{ speaker: "药老", channel: "spoken", text: "小子，你我有缘" }],
            emotion: "神秘",
            emotion_intensity: 1,
            entry_state: "戒指微光脉动",
            exit_state: "声音落下，光芒稍稳",
        },
        {
            id: "s3",
            beat_ids: ["e4-a", "e4-d1"],
            segment_index: 0,
            segment_title: "苏醒",
            location: "山洞",
            time: "夜",
            duration: 6,
            shot_type: "MS",
            camera_angle: "eye level",
            camera_movement: "static",
            lighting_style: "night",
            depth_of_field: "medium",
            action: "萧炎猛地睁开双眼，迅速环顾四周，洞中空无一人，最后盯住手上的戒指",
            result: "他盯住手上的戒指",
            dialogue: [{ speaker: "萧炎", channel: "inner", text: "这声音来自戒指里的灵魂" }],
            emotion: "警觉",
            emotion_intensity: 2,
            entry_state: "萧炎闭目，戒指在手",
            exit_state: "萧炎睁眼盯住戒指",
        },
    ],
};

const segmentSeconds = 15;

// 复刻 page.tsx 里的 extractJson：模型可能把 JSON 包在 ```json 代码块里。
function extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = (fenced ? fenced[1] : text).trim();
    const start = body.search(/[[{]/);
    if (start < 0) return null;
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (end < start) return null;
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch {
        return null;
    }
}

test("单集 3 镜：剧本→beats→分镜→打包 全链路跑通", () => {
    // ① 请求消息构造（真实函数）
    const screenplayMessages = buildScreenplayAdaptationMessages({
        script: EPISODE_SCRIPT,
        title: "药老苏醒",
        characters: ["萧炎", "药老"],
        scenes: ["山洞"],
        props: ["戒指"],
        adaptationLevel: "performance",
        segmentSeconds,
    });
    expect(Array.isArray(screenplayMessages)).toBe(true);
    expect(screenplayMessages.length).toBeGreaterThan(0);

    // ② 模型返回 → 归一化出 beats
    const screenplay = normalizeScreenplay(extractJson(JSON.stringify(SCREENPLAY_STUB)), EPISODE_SCRIPT);
    expect(screenplay.beats.length).toBeGreaterThanOrEqual(3);
    // 关键剧情事件必须被覆盖，否则编排层会直接拒绝出片。
    expect(screenplay.screenplay.coverage.requiredMissing).toEqual([]);
    const beats: DramaBeat[] = screenplay.beats;

    // ③ 分镜规划消息构造
    const shotMessages = buildShotPlanMessages({
        beats,
        style: "国画水墨",
        aspect: "16:9",
        targetShots: 3,
        characters: ["萧炎", "药老"],
        scenes: ["山洞"],
        props: ["戒指"],
    });
    expect(shotMessages.length).toBeGreaterThan(0);

    // ④ 模型返回 → 归一化成分镜计划
    let plan: DramaShotPlan[] = normalizeShotPlan(extractJson(JSON.stringify(SHOT_PLAN_STUB)), beats);
    expect(plan.length).toBe(3);

    // ⑤ 校验（真实规则）
    let validation = validateStoryboardPlan(plan, beats, segmentSeconds);
    if (!validation.ok) {
        const repaired = repairStoryboardPlan(plan, segmentSeconds);
        const repairedValidation = validateStoryboardPlan(repaired, beats, segmentSeconds);
        if (repairedValidation.ok) {
            plan = repaired;
            validation = repairedValidation;
        }
    }
    expect(validation.errors).toEqual([]);

    // ⑥ 转分镜卡 → 弹性打包
    const shots = elasticPackShots(planToShots(plan), segmentSeconds);
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(sanityCheckPackedShots(shots)).toEqual([]);

    // ⑦ 每张卡都要有可拍的画面描述，且时长不超硬上限。
    for (const shot of shots) {
        expect(shot.action.trim().length).toBeGreaterThan(0);
        expect(shot.result.trim().length).toBeGreaterThan(0);
        expect(shot.duration || 0).toBeLessThanOrEqual(25);
        expect(shot.shotNumber).toBeGreaterThan(0);
    }

    // ⑧ 台词必须逐句保留到卡片上（这是缺陷 1 的回归点）。
    const allDialogue = shots.map((shot) => shot.dialogue).join("\n");
    expect(allDialogue).toContain("小子，你我有缘");
    expect(allDialogue).toContain("这声音来自戒指里的灵魂");

    // ⑨ 卡片时长必须装得下其台词。
    for (const shot of shots) {
        const seconds = estimateShotSeconds(shot);
        expect(seconds).toBeLessThanOrEqual(25);
        expect(seconds).toBeGreaterThanOrEqual(2);
    }
});

test("单集 3 镜：建卡后续跑计划判定全部完成，重跑时正确复用", () => {
    const screenplay = normalizeScreenplay(extractJson(JSON.stringify(SCREENPLAY_STUB)), EPISODE_SCRIPT);
    const beats = screenplay.beats;
    const plan = normalizeShotPlan(extractJson(JSON.stringify(SHOT_PLAN_STUB)), beats);
    const shots = elasticPackShots(planToShots(plan), segmentSeconds);

    // 模拟编排层建卡：分镜卡建好并登记 nodeId。
    const nodes: CanvasNodeData[] = shots.map((shot, index) => ({
        id: `story-${index + 1}`,
        type: "text",
        title: `分镜 ${shot.shotNumber}`,
        position: { x: 0, y: index * 260 },
        width: 360,
        height: 240,
        metadata: { content: shot.action, status: "success" },
    }) as CanvasNodeData);
    const run = markDramaRunStoryboardsDone(
        createDramaRun("ep-1", shots, "2026-11-21T00:00:00.000Z"),
        Object.fromEntries(shots.map((shot, index) => [shot.shotNumber, nodes[index].id])),
        "2026-11-21T00:00:00.000Z",
    );
    expect(run.storyboardsDone).toBe(true);
    expect(run.items.length).toBe(shots.length);

    // 参考图模式：分镜已建、视频还没做 → 应复用分镜卡并生成视频，而不是重建。
    const first = buildDramaResumePlan({ run, shots, nodes, useReference: true });
    expect(first.storyboard).toBe("reuse");
    expect(first.complete).toBe(false);
    for (const item of first.items) {
        expect(item.storyAction).toBe("skip");
        expect(item.videoAction.kind).toBe("generate");
    }

    // 模拟视频全部产出后，再算一次应判定完成、全部跳过。
    const videoNodes: CanvasNodeData[] = first.items.map((item, index) => ({
        id: `video-${index + 1}`,
        type: "video",
        title: `视频 ${index + 1}`,
        position: { x: 800, y: index * 260 },
        width: 320,
        height: 180,
        metadata: { content: "done.mp4", status: "success" },
    }) as CanvasNodeData);
    const runDone = videoNodes.reduce(
        (acc, node, index) => ({ ...acc, items: acc.items.map((item) => (item.shotNumber === shots[index].shotNumber ? { ...item, videoNodeId: node.id, done: true } : item)) }),
        run,
    );
    const second = buildDramaResumePlan({ run: runDone, shots, nodes: [...nodes, ...videoNodes], useReference: true });
    expect(second.complete).toBe(true);
});

test("单集 3 镜：每个镜头都能生成合法的 H3 参考模式提示词", () => {
    const screenplay = normalizeScreenplay(extractJson(JSON.stringify(SCREENPLAY_STUB)), EPISODE_SCRIPT);
    const plan = normalizeShotPlan(extractJson(JSON.stringify(SHOT_PLAN_STUB)), screenplay.beats);
    const shots = elasticPackShots(planToShots(plan), segmentSeconds);
    const refs = [
        { name: "萧炎", kind: "character" as const, description: "少年，黑发，粗布衣" },
        { name: "山洞", kind: "scene" as const, description: "昏暗山洞，石壁" },
        { name: "戒指", kind: "prop" as const, description: "古旧黑色戒指" },
    ];

    for (const shot of shots) {
        const prompt = buildRef2VAPrompt(shot, refs, "国画水墨");
        // 参考模式必备六段结构。
        for (const section of ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]) {
            expect(prompt).toContain(`${section}:`);
        }
        // 每个参考都必须绑定到具体图片号，不能凭空发明编号。
        refs.forEach((ref, index) => expect(prompt).toContain(`<Picture ${index + 1}>: ${ref.name}`));
        // 输出规整后必须仍是合法 H3 提示词（越界图片号/缺段都会被拒）。
        const normalized = normalizeH3Prompt(prompt, "reference", refs.length);
        expect(normalized.length).toBeGreaterThan(80);
        expect(normalized).toContain("non_diegetic_music: N/A");
        // 禁止字幕与水印是硬性要求。
        expect(normalized.toLowerCase()).toContain("no subtitles");
    }
});

test("单集 3 镜：台词在提示词补全后不丢行（缺陷 1 端到端回归）", () => {
    // 复刻 page.tsx 的 ensureSpokenDialogue 关键逻辑：检查提示词里有没有漏台词。
    const ensureSpokenDialogue = (prompt: string, dialogue: string) => {
        const lines = parseDialogueLines(dialogue);
        if (!lines.length) return prompt;
        const norm = (value: string) => value.replace(/[\s“”「」"'，,。.!！?？…：:；;（）()<>\/[\]a-zA-Z-]/g, "");
        const spoken = [...prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi)].map((match) => norm(match[1]));
        const missing = lines.filter((line) => {
            const core = norm(line.text);
            return core.length > 0 && !spoken.some((entry) => entry.includes(core));
        });
        if (!missing.length) return prompt;
        const injected = missing
            .map((line) => {
                const cue = line.channel === "inner" ? `${line.speaker || "S1"} (inner voice, lips remain completely closed, no lip-sync): ` : line.channel === "system" ? "SYS (off-screen system voice, no visible speaker): " : "";
                return `${cue}<d>[Chinese] ${line.text}</d>`;
            })
            .join(" ");
        return /overall_soundscape\s*:/i.test(prompt) ? prompt.replace(/(\n\s*overall_soundscape\s*:)/i, `\n${injected}\n$1`) : `${prompt}\n${injected}`;
    };

    // 无说话人写法的台词过去会被静默丢弃，修复后必须被补进提示词。
    const dialogue = "[内心]我不能退\n[画外]门被推开";
    const prompt = `subject_definitions:
<Picture 1>: 萧炎 (costume matches)

summary: A single continuous shot.

retention_analysis: Keep faces.

detailed_description: 他站在原地。

overall_soundscape: 风声。

non_diegetic_music: N/A`;
    const patched = ensureSpokenDialogue(prompt, dialogue);
    expect(patched).toContain("<d>[Chinese] 我不能退</d>");
    expect(patched).toContain("<d>[Chinese] 门被推开</d>");
    // 内心戏必须标注闭口，画外音必须标注无可见说话人。
    expect(patched).toContain("lips remain completely closed");
    expect(patched).toContain("no visible speaker");
    // 补进去的提示词仍然要能通过 H3 规整。
    expect(normalizeH3Prompt(patched, "reference", 1).length).toBeGreaterThan(80);
});

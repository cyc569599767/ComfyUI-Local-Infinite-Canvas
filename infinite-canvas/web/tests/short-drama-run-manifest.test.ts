import { expect, test } from "bun:test";
import { buildDramaResumePlan, createDramaRun, markDramaRunStoryboardsDone, summarizeDramaRun, updateDramaRunItem } from "../src/lib/short-drama/run-manifest";
import type { CanvasDramaStoryboardShot, CanvasNodeData } from "../src/types/canvas";

const shot = (shotNumber: number): CanvasDramaStoryboardShot => ({
    shotNumber,
    title: `镜头 ${shotNumber}`,
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
});

const node = (id: string, type: string, metadata: Record<string, unknown> = {}): CanvasNodeData =>
    ({ id, type, title: id, position: { x: 0, y: 0 }, width: 200, height: 120, metadata }) as CanvasNodeData;

const AT = "2026-11-21T10:00:00.000Z";

test("新建运行记录按分镜顺序生成条目且未完成", () => {
    const run = createDramaRun("ep-1", [shot(1), shot(2)], AT);
    expect(run.episodeId).toBe("ep-1");
    expect(run.storyboardsDone).toBe(false);
    expect(run.updatedAt).toBe(AT);
    expect(run.items.map((item) => item.shotNumber)).toEqual([1, 2]);
    // 新建时不应预先写入任何节点 id 或完成标记。
    expect(run.items.every((item) => !item.storyNodeId && !item.done)).toBe(true);
});

test("标记分镜完成时合并节点 id，未提供 id 的镜头保留原值", () => {
    const run = createDramaRun("ep-1", [shot(1), shot(2)], AT);
    const done = markDramaRunStoryboardsDone(run, { 1: "node-a" }, AT);
    expect(done.storyboardsDone).toBe(true);
    expect(done.items[0].storyNodeId).toBe("node-a");
    expect(done.items[1].storyNodeId).toBeUndefined();
    // 原对象不可变，避免与已保存画布状态互相污染。
    expect(run.storyboardsDone).toBe(false);
    expect(run.items[0].storyNodeId).toBeUndefined();
});

test("更新单个镜头条目只影响目标镜头，行为不可变", () => {
    const run = createDramaRun("ep-1", [shot(1), shot(2)], AT);
    const next = updateDramaRunItem(run, 2, { videoNodeId: "v2", done: true, lastError: "重试" }, AT);
    expect(next.items[1]).toMatchObject({ videoNodeId: "v2", done: true, lastError: "重试" });
    expect(next.items[0]).toEqual(run.items[0]);
    expect(run.items[1].videoNodeId).toBeUndefined();
    // 不存在的镜号是空操作而不是抛错。
    expect(updateDramaRunItem(run, 99, { done: true }, AT).items).toEqual(run.items);
});

test("无运行记录时全部重新建卡并生成视频", () => {
    const plan = buildDramaResumePlan({ run: null, shots: [shot(1)], nodes: [], useReference: true });
    expect(plan.storyboard).toBe("generate");
    expect(plan.complete).toBe(false);
    expect(plan.items[0]).toMatchObject({ storyAction: "create", videoAction: { kind: "generate", recreate: true } });
    // 参考图模式不需要首帧卡。
    expect(plan.items[0].frameAction).toEqual({ kind: "skip" });
});

test("分镜未完成时不得复用，即使条目里已有节点 id", () => {
    const run = updateDramaRunItem(createDramaRun("ep-1", [shot(1)], AT), 1, { storyNodeId: "node-a" }, AT);
    const plan = buildDramaResumePlan({ run, shots: [shot(1)], nodes: [node("node-a", "text")], useReference: true });
    // storyboardsDone 为 false 说明上次没走完建卡流程，必须重来。
    expect(plan.storyboard).toBe("generate");
    expect(plan.items[0].storyAction).toBe("create");
});

test("分镜已完成但节点被删时重建该镜头，而不是跳过", () => {
    const run = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1), shot(2)], AT), { 1: "node-a", 2: "node-b" }, AT);
    const plan = buildDramaResumePlan({ run, shots: [shot(1), shot(2)], nodes: [node("node-a", "text")], useReference: true });
    expect(plan.storyboard).toBe("reuse");
    expect(plan.items[0].storyAction).toBe("skip");
    // node-b 已不存在于画布，必须重建。
    expect(plan.items[1].storyAction).toBe("recreate");
});

test("视频有内容跳过、有任务号续跑、两者都无则重新生成", () => {
    let run = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1), shot(2)], AT), { 1: "a", 2: "b" }, AT);
    run = updateDramaRunItem(run, 1, { videoNodeId: "v-done" }, AT);
    run = updateDramaRunItem(run, 2, { videoNodeId: "v-task" }, AT);
    const nodes = [
        node("a", "text"),
        node("b", "text"),
        node("v-done", "video", { content: "done.mp4" }),
        node("v-task", "video", { videoTaskId: "task-9" }),
    ];
    const plan = buildDramaResumePlan({ run, shots: [shot(1), shot(2)], nodes, useReference: true });
    expect(plan.items[0].videoAction).toEqual({ kind: "skip" });
    // 有 taskId 说明请求已提交，应查询而不是重新提交。
    expect(plan.items[1].videoAction).toEqual({ kind: "resume" });
});

test("视频节点存在但既无内容也无任务号时按非重建方式再生成", () => {
    const run = updateDramaRunItem(markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1)], AT), { 1: "a" }, AT), 1, { videoNodeId: "v-empty" }, AT);
    const plan = buildDramaResumePlan({ run, shots: [shot(1)], nodes: [node("a", "text"), node("v-empty", "video")], useReference: true });
    // 节点已建好，只差生成，不需要重建卡片。
    expect(plan.items[0].videoAction).toEqual({ kind: "generate", recreate: false });
});

test("首帧模式：缺帧卡要新建，有卡无图只补图，已有图则跳过", () => {
    const base = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1)], AT), { 1: "a" }, AT);

    const noFrame = buildDramaResumePlan({ run: base, shots: [shot(1)], nodes: [node("a", "text")], useReference: false });
    expect(noFrame.items[0].frameAction).toEqual({ kind: "generate", recreate: true });

    const withEmptyFrame = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1)], AT), { 1: "a" }, AT);
    const emptyPlan = buildDramaResumePlan({
        run: updateDramaRunItem(withEmptyFrame, 1, { frameNodeId: "f1" }, AT),
        shots: [shot(1)],
        nodes: [node("a", "text"), node("f1", "image")],
        useReference: false,
    });
    expect(emptyPlan.items[0].frameAction).toEqual({ kind: "generate", recreate: false });

    const filledPlan = buildDramaResumePlan({
        run: updateDramaRunItem(withEmptyFrame, 1, { frameNodeId: "f1" }, AT),
        shots: [shot(1)],
        nodes: [node("a", "text"), node("f1", "image", { content: "first.png" })],
        useReference: false,
    });
    expect(filledPlan.items[0].frameAction).toEqual({ kind: "skip" });
});

test("参考图模式不生成首帧，即使视频还没做完", () => {
    const run = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1)], AT), { 1: "a" }, AT);
    const plan = buildDramaResumePlan({ run, shots: [shot(1)], nodes: [node("a", "text")], useReference: true });
    expect(plan.items[0].videoAction.kind).toBe("generate");
    expect(plan.items[0].frameAction).toEqual({ kind: "skip" });
});

test("全部镜头建卡、出图、出片齐备时判定 complete 且全部跳过", () => {
    let run = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1)], AT), { 1: "a" }, AT);
    run = updateDramaRunItem(run, 1, { videoNodeId: "v1", frameNodeId: "f1", done: true }, AT);
    const plan = buildDramaResumePlan({
        run,
        shots: [shot(1)],
        nodes: [node("a", "text"), node("f1", "image", { content: "f.png" }), node("v1", "video", { content: "v.mp4" })],
        useReference: false,
    });
    expect(plan.complete).toBe(true);
    expect(plan.storyboard).toBe("reuse");
    expect(plan.items[0]).toMatchObject({ storyAction: "skip", frameAction: { kind: "skip" }, videoAction: { kind: "skip" } });
});

test("分镜数量增加时旧镜头复用、新增镜头重新建卡", () => {
    const run = markDramaRunStoryboardsDone(createDramaRun("ep-1", [shot(1)], AT), { 1: "a" }, AT);
    const plan = buildDramaResumePlan({ run, shots: [shot(1), shot(2)], nodes: [node("a", "text")], useReference: true });
    expect(plan.items.map((item) => item.storyAction)).toEqual(["skip", "create"]);
    // 有任一镜头需要新建时，整体不算完成。
    expect(plan.complete).toBe(false);
});

test("汇总统计只统计失败数，不把未完成误判为失败", () => {
    let run = createDramaRun("ep-1", [shot(1), shot(2), shot(3)], AT);
    run = updateDramaRunItem(run, 2, { lastError: "模型未就绪" }, AT);
    const summary = summarizeDramaRun(run);
    expect(summary).toEqual({ total: 3, failed: 1 });
    // done 与 lastError 是独立维度：未完成但没有错误不应计入失败。
    expect(summarizeDramaRun(updateDramaRunItem(run, 2, { lastError: undefined, done: true }, AT)).failed).toBe(0);
});

import { expect, test } from "bun:test";
import { CREATION_STAGES, defaultCreationPipeline, validatePipelineConfig, validateCreationPlan, inspectCreationStage, inspectCreationExecution, guardCreationOps, type CreationPipelineState, type CreationStageId, type CreationPlan } from "../src/lib/agent/creation-pipeline";
import type { CanvasNodeData } from "../src/types/canvas";
const plan: CreationPlan = {
    assets: [{ id: "person", kind: "character", label: "守塔人" }, { id: "scene", kind: "scene", label: "灯塔" }],
    shots: [{ id: "shot1", label: "点灯", referenceIds: ["person", "scene"], promptNodeId: "prompt1", videoNodeId: "video1" }],
    voiceIds: [], musicIds: [], omitted: { prop: "无独立道具", costume: "无换装", age: "无年龄变化", voice: "无台词", music: "只需环境音" },
};
const node = (id: string, stage: CreationStageId, type = "text", status: "idle" | "loading" | "success" | "error" = "success", content = "正文"): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { creationOutput: { projectNodeId: "wb", stage }, content, status } });
const before = (stage: CreationStageId): CreationPipelineState => ({ version: 1, plan, completed: CREATION_STAGES.slice(0, CREATION_STAGES.findIndex((s) => s.id === stage)).map((s) => s.id) });
const readyNodes = () => [node("novel", "novel"), node("script", "script"), node("person", "character", "image"), node("scene", "scene", "image"), node("shot1", "storyboard"), node("prompt1", "video_prompt")];

test("音乐等待区分缺失、未启动、活动请求和幽灵loading，并保留错误", () => {
    const state = { ...before("music"), plan: { ...plan, musicIds: ["music-storm-night"] } };
    const music = node("music-storm-night", "music", "audio", "loading", "");
    expect(inspectCreationExecution("music", state, [], "wb", true, true, () => false).outputs[0].status).toBe("missing");
    const ghost = inspectCreationExecution("music", state, [music], "wb", true, true, () => false);
    expect(ghost.waiting).toBe(false);expect(ghost.error).toContain("没有活动生成请求");
    const active = inspectCreationExecution("music", state, [music], "wb", true, true, () => true);
    expect(active.waiting).toBe(true);expect(active.outputs[0].status).toBe("request_active");expect(active.evidence).toContain("不代表GPU");
    music.metadata!.status = "error";music.metadata!.errorDetails = "模型配置未就绪";
    expect(inspectCreationExecution("music", state, [music], "wb", true, true, () => false).outputs[0]).toMatchObject({status:"failed",error:"模型配置未就绪"});
});

test("精确复刻12环节25绑定17技能，配置保持顺序并校验", () => {
    const config = defaultCreationPipeline();
    expect(CREATION_STAGES.map((s) => s.id)).toEqual(["novel", "script", "character", "prop", "scene", "costume", "age", "voice", "storyboard", "video_prompt", "music", "pipeline"]);
    const skills = Object.values(config.nodes).flatMap((s) => s.skills);
    expect(skills).toHaveLength(25); expect(new Set(skills).size).toBe(17);
    config.nodes.script.skills.reverse();
    expect(validatePipelineConfig(config).nodes.script.skills).toEqual(config.nodes.script.skills);
    expect(() => validatePipelineConfig({ nodes: { unexpected: {} } })).toThrow();
});
test("计划要求全量类别、唯一ID和真实引用关系", () => {
    expect(validateCreationPlan(plan)).toEqual(plan);
    expect(() => validateCreationPlan({ ...plan, omitted: {} })).toThrow("omitted");
    expect(() => validateCreationPlan({ ...plan, assets: [...plan.assets, { id: "costume", kind: "costume", label: "换装" }] })).toThrow("parentId");
    expect(() => validateCreationPlan({ ...plan, voiceIds: ["person"] })).toThrow("唯一");
    expect(() => validateCreationPlan({ ...plan, shots: [{ ...plan.shots[0], referenceIds: ["unknown"] }] })).toThrow("设定图");
});
test("人物、场景全部真实完成才能创建分镜，失败和缺图均阻断", () => {
    const nodes = readyNodes().filter((n) => n.id !== "shot1" && n.id !== "prompt1");
    const ops = [{ type: "add_node" as const, id: "shot1", nodeType: "text", metadata: { content: "分镜1" } }];
    expect(guardCreationOps(ops, nodes, "wb", before("storyboard"))).toHaveLength(1);
    for (const status of ["idle", "loading", "error"] as const) {
        const failed = nodes.map((n) => n.id === "scene" ? { ...n, metadata: { ...n.metadata, status } } : n);
        expect(() => guardCreationOps(ops, failed, "wb", before("storyboard"))).toThrow("前置");
    }
    expect(() => guardCreationOps(ops, nodes.filter((n) => n.id !== "person"), "wb", before("storyboard"))).toThrow("前置");
});
test("阶段只接受自己的节点类型和计划ID，不能提前分镜或视频", () => {
    const nodes = readyNodes().slice(0, 2);
    expect(() => guardCreationOps([{ type: "add_node", id: "shot1", nodeType: "text" }], nodes, "wb", before("character"))).toThrow("计划");
    expect(() => guardCreationOps([{ type: "add_node", id: "person", nodeType: "video" }], nodes, "wb", before("character"))).toThrow("只允许");
});
test("Agent不能伪造媒体结果或伪造已完成阶段", () => {
    for (const metadata of [{ content: "https://fake/image.png" }, { status: "success" as const }, { storageKey: "fake" }, { creationPipeline: before("pipeline") }]) {
        expect(() => guardCreationOps([{ type: "add_node", id: "person", nodeType: "image", metadata }], readyNodes().slice(0, 2), "wb", before("character"))).toThrow();
    }
    expect(() => guardCreationOps([{ type: "update_node", id: "wb", patch: { type: "text" } }], [], "wb", before("novel"))).toThrow();
});
test("已成功但没有媒体内容不是完成；同项目同阶段匹配", () => {
    expect(inspectCreationStage("character", before("character"), [node("person", "character", "image", "success", "")], "wb").ready).toBe(false);
    expect(inspectCreationStage("character", before("character"), [node("person", "scene", "image")], "wb").ready).toBe(false);
    expect(inspectCreationStage("character", before("character"), [node("person", "character", "image", "loading", "")], "wb").waiting).toBe(true);
});
test("视频有完成提示词才生成，并强制绑定计划中的有序参考图", () => {
    const nodes = readyNodes();
    const state = before("pipeline");
    const ops = [{ type: "add_node" as const, id: "video1", nodeType: "video", metadata: { prompt: "不可信另一个提示词", model: "real-model" } }, { type: "run_generation" as const, nodeId: "video1", mode: "video" as const, prompt: "跳过已确认提示词" }];
    const guarded = guardCreationOps(ops, nodes, "wb", state);
    expect(guarded).toContainEqual({ type: "connect_nodes", fromNodeId: "person", toNodeId: "video1" });
    expect(guarded).toContainEqual({ type: "connect_nodes", fromNodeId: "scene", toNodeId: "video1" });
    expect(guarded.at(-1)).toMatchObject({ type: "run_generation", prompt: "正文" });
    expect(() => guardCreationOps(ops, nodes.filter((n) => n.id !== "prompt1"), "wb", state)).toThrow("video_prompt");
});
test("十张空prompt视频卡从各自已确认文本卡读取全文，不要求复制", () => {
    const state = before("pipeline");
    state.plan = { ...plan, shots: Array.from({length:10},(_,i)=>({id:`shot-${i}`,label:`镜头${i+1}`,referenceIds:["person","scene"],promptNodeId:`prompt-${i}`,videoNodeId:`video-${i}`})) };
    const base=readyNodes().filter(n=>!["shot1","prompt1"].includes(n.id));
    const nodes=[...base,...state.plan.shots.flatMap(s=>[node(s.id,"storyboard"),node(s.promptNodeId,"video_prompt","text","success",`${s.label}\n${"完整镜头文本，保持对白、动作和参考编号。".repeat(160)}`),node(s.videoNodeId,"pipeline","video","idle","")])];
    const original=JSON.stringify(nodes);
    for(const shot of state.plan.shots){
        const ops=guardCreationOps([{type:"run_generation",nodeId:shot.videoNodeId,mode:"video"}],nodes,"wb",state);
        expect(ops.at(-1)).toMatchObject({type:"run_generation",prompt:nodes.find(n=>n.id===shot.promptNodeId)!.metadata!.content});
        expect(ops.filter(o=>o.type==="connect_nodes").map(o=>o.type==="connect_nodes"&&o.fromNodeId)).toEqual(["person","scene"]);
    }
    const check=inspectCreationExecution("pipeline",state,nodes,"wb",true,true,()=>false);
    expect(check.outputs).toHaveLength(10);
    expect(check.outputs.every(o=>o.promptSource?.ready&&o.promptSource.characters>2000)).toBe(true);
    expect(JSON.stringify(nodes)).toBe(original);
});
test("同批新增空视频卡可生成，非视频空prompt仍拒绝",()=>{
    const ops=guardCreationOps([{type:"add_node",id:"video1",nodeType:"video"},{type:"run_generation",nodeId:"video1",mode:"video"}],readyNodes(),"wb",before("pipeline"));
    expect(ops.at(-1)).toMatchObject({type:"run_generation",prompt:"正文"});
    expect(()=>guardCreationOps([{type:"run_generation",nodeId:"person",mode:"image"}], [...readyNodes().slice(0,2),node("person","character","image","idle","")],"wb",before("character"))).toThrow("缺少生成提示词");
});
test("视频自身非空也不能绕过缺失失效跨项目或历史提示词来源",()=>{
    const video=node("video1","pipeline","video","idle","");video.metadata!.prompt="临时补写不能兜底";
    for(const patch of [{content:""},{creationOutput:{projectNodeId:"wb",stage:"video_prompt" as const,needsRevision:true}},{creationOutput:{projectNodeId:"other",stage:"video_prompt" as const}},{creationOutput:{projectNodeId:"wb",stage:"video_prompt" as const,revisionKind:"history" as const}}]){
        const nodes=[...readyNodes().map(n=>n.id==="prompt1"?{...n,metadata:{...n.metadata,...patch}}:n),video];
        expect(()=>guardCreationOps([{type:"run_generation",nodeId:"video1",mode:"video",prompt:"绕过文本"}],nodes,"wb",before("pipeline"))).toThrow();
    }
});

test("空类别用计划说明跳过，不把文本预演当真实设定图", () => {
    expect(inspectCreationStage("prop", before("prop"), [], "wb").ready).toBe(true);
    expect(inspectCreationStage("character", before("character"), [node("person", "character")], "wb", false).ready).toBe(true);
    expect(() => guardCreationOps([{ type: "run_generation", nodeId: "person", mode: "image" }], [node("novel", "novel"), node("script", "script"), node("person", "character")], "wb", before("character"), false)).toThrow();
});
test("保护其他项目和已生成产物，禁止删除与重复提交", () => {
    expect(() => guardCreationOps([{ type: "delete_node", id: "person" }], readyNodes().slice(0, 2), "wb", before("character"))).toThrow("禁止删除");
    expect(() => guardCreationOps([{ type: "run_generation", nodeId: "person", mode: "image" }], readyNodes(), "wb", before("character"))).toThrow("重复提交");
});

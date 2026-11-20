import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CanvasAgentSnapshot, CanvasAgentOp } from "../src/lib/canvas/canvas-agent-ops";
import type { AgentCreationSeed } from "../src/lib/agent/agent-creation-task";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { useCreationAgentStore: creation } = await import("../src/stores/use-creation-agent-store");
const { useAgentStore: canvas } = await import("../src/stores/use-agent-store");
const { useConfigStore: config } = await import("../src/stores/use-config-store");
const { useAgentChatStore: chat } = await import("../src/stores/use-agent-chat-store");
const { startCreationRun, stopCreationRun, resolveCreationApproval, requestCreationRevision } = await import("../src/lib/agent/creation-agent-runtime");
const { useCreationPipelineStore: pipeline } = await import("../src/stores/use-creation-pipeline-store");
const { defaultCreationPipeline } = await import("../src/lib/agent/creation-pipeline");
const originalFetch = globalThis.fetch;
let snapshot: CanvasAgentSnapshot;
let applied: CanvasAgentOp[];
let activeIds: Set<string> | undefined;
const requests: Array<{ body: any; resolve: (response: Response) => void; signal?: AbortSignal }> = [];
const configBefore = config.getState().config;
const chatBefore = chat.getState();
const canvasBefore = canvas.getState();
function publish() {
    canvas.getState().setCanvasContext({ snapshot, canUndo: false, isGenerationActive: activeIds ? (id) => activeIds!.has(id) : undefined, undoOps: () => null, applyOps: (ops = []) => {
        applied.push(...ops);
        for (const op of ops) {
            if (op.type === "update_node") snapshot = { ...snapshot, nodes: snapshot.nodes.map((node) => node.id === op.id ? { ...node, metadata: { ...node.metadata, ...op.metadata } } : node) };
            if (op.type === "add_node") snapshot = { ...snapshot, nodes: [...snapshot.nodes, { id: op.id || "new", type: op.nodeType, title: op.title || "", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: op.metadata }] };
        }
        publish();
        return snapshot;
    } });
}
const seed = (id = "wb-a"): AgentCreationSeed => ({ seedId: `seed-${id}`, projectNodeId: id, projectTitle: id, idea: "灯塔守护者", style: "电影感", aspectRatio: "16:9", targetSeconds: 20, createImages: false, createVideos: false, continueExisting: false, progress: "" });
const answer = (text: string) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), { headers: { "Content-Type": "application/json" } });
const tools = (ops: CanvasAgentOp[]) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "skill-1", type: "function", function: { name: "skill", arguments: "{}" } }, { id: "tool-1", type: "function", function: { name: "canvas_apply_ops", arguments: JSON.stringify({ ops }) } }] } }] }), { headers: { "Content-Type": "application/json" } });
async function until(check: () => boolean) {
    for (let i = 0; i < 1000; i++) {
        if (check()) return;
        await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    throw new Error("状态未按预期到达");
}
beforeEach(async () => {
    await creation.persist.rehydrate();
    await pipeline.persist.rehydrate();
    pipeline.setState({ hydrated: true, config: defaultCreationPipeline(), files: { "webnovel-writing/SKILL.md": Buffer.from("测试技能正文").toString("base64"), "webnovel-writing/SKILL.cn.md": Buffer.from("测试技能正文").toString("base64") } });
    creation.setState({ conversations: [], runs: {}, hydrated: true, confirmBeforeApply: false });
    config.setState({ config: { ...configBefore, promptCloudApis: [{ id: "test-shared", name: "test", baseUrl: "https://example.invalid/v1", apiKey: "test-only-secret", model: "shared-test-model" }], promptCloudApiId: "test-shared" } });
    applied = []; requests.length = 0; activeIds = undefined;
    snapshot = { projectId: "canvas-a", title: "测试画布", connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, scale: 1 }, nodes: ["wb-a", "wb-b"].map((id) => ({ id, type: "workbench", title: id, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { workbenchKind: "agent-creation" } })) };
    publish();
    globalThis.fetch = ((url: unknown, init: RequestInit) => {
        if (String(url).startsWith("/creation-skills/")) return Promise.resolve(new Response(readFileSync(`public${String(url)}`)));
        return new Promise<Response>((resolve, reject) => {
        requests.push({ body: JSON.parse(String(init.body)), resolve, signal: init.signal || undefined });
        init.signal?.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true });
    }); }) as typeof fetch;
});
afterEach(async () => {
    for (const id of Object.keys(creation.getState().runs)) stopCreationRun(id);
    await until(() => !Object.keys(creation.getState().runs).length);
    globalThis.fetch = originalFetch;
    config.setState({ config: configBefore });
    canvas.setState(canvasBefore);
    chat.setState(chatBefore);
});
afterAll(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("重做操作停止本项目Agent且不触碰另一个会话，也不重复调用模型", async () => {
    snapshot.nodes.push({id:"asset-a",type:"image",title:"人物",position:{x:0,y:0},width:200,height:200,metadata:{status:"success",content:"fixture",creationOutput:{projectNodeId:"wb-a",stage:"character"}}});
    publish();
    startCreationRun(seed()); startCreationRun(seed("wb-b"));
    await requestCreationRevision("wb-a","asset-a","衣服改蓝色");
    expect(requests[0].signal?.aborted).toBe(true);
    expect(creation.getState().runs["wb-a"]).toBeUndefined();
    expect(creation.getState().runs["wb-b"]).toBeDefined();
    expect(requests).toHaveLength(2);
    expect(applied.filter(op=>op.type==="run_generation")).toHaveLength(1);
    expect(applied.some(op=>op.type==="revise_creation"&&op.projectNodeId==="wb-a")).toBe(true);
});

test("创作启动不改画布聊天；使用同一云端配置并保存真实会话ID", async () => {
    canvas.setState({ sending: true, waiting: true });
    const before = chat.getState().conversations;
    const id = startCreationRun(seed());
    expect(requests[0].body).toMatchObject({ baseUrl: "https://example.invalid/v1", apiKey: "test-only-secret", request: { model: "shared-test-model" } });
    expect(snapshot.nodes[0].metadata?.agentCreation?.conversationId).toBe(id);
    expect(chat.getState().conversations).toBe(before);
    requests[0].resolve(answer("蓝图完成，可继续"));
    await until(() => !creation.getState().runs["wb-a"]);
    expect(canvas.getState().sending).toBe(true);
    expect(canvas.getState().waiting).toBe(true);
    expect(creation.getState().conversationFor("wb-a")?.status).toBe("ready");
    expect(snapshot.nodes[0].metadata?.agentCreation?.progress).toBe("蓝图完成，可继续");
});

test("并发项目各自审批；停止等待中的A不影响B，并能立即续跑", async () => {
    creation.getState().setConfirmBeforeApply(true);
    startCreationRun(seed()); startCreationRun(seed("wb-b"));
    expect(Object.keys(creation.getState().runs)).toHaveLength(2);
    requests[0].resolve(tools([{ type: "add_node", id: "a-output", nodeType: "text" }]));
    requests[1].resolve(tools([{ type: "add_node", id: "b-output", nodeType: "text" }]));
    await until(() => Boolean(creation.getState().runs["wb-a"]?.pendingApproval && creation.getState().runs["wb-b"]?.pendingApproval));
    stopCreationRun("wb-a");
    await until(() => !creation.getState().runs["wb-a"]);
    expect(creation.getState().runs["wb-b"].pendingApproval).not.toBeNull();
    resolveCreationApproval("wb-b", true);
    await until(() => requests.length === 3);
    requests[2].resolve(answer("B已完成"));
    await until(() => requests.length === 4);
    expect(creation.getState().runs["wb-b"]).toBeDefined();
    requests[3].resolve(answer("没有新的产物"));
    await until(() => !creation.getState().runs["wb-b"]);
    expect(snapshot.nodes.some((node) => node.id === "a-output")).toBe(false);
    expect(snapshot.nodes.some((node) => node.id === "b-output")).toBe(true);
    const id = startCreationRun({ ...seed(), continueExisting: true });
    expect(id).toBe(creation.getState().conversationFor("wb-a")?.id);
    requests[4].resolve(answer("A续跑完成"));
    await until(() => !creation.getState().runs["wb-a"]);
    expect(creation.getState().conversationFor("wb-a")?.status).toBe("ready");
});

test("跨画布切换终止旧任务，不能读写新画布", async () => {
    startCreationRun(seed());
    snapshot = { ...snapshot, projectId: "canvas-b", nodes: [] };
    publish();
    await until(() => !creation.getState().runs["wb-a"]);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(snapshot.nodes).toHaveLength(0);
    expect(creation.getState().conversationFor("wb-a")?.progress).toContain("画布已切换");
});

test("拒绝写入不执行，不会再次循环提交同一批", async () => {
    creation.getState().setConfirmBeforeApply(true);
    startCreationRun(seed());
    requests[0].resolve(tools([{ type: "add_node", id: "refused", nodeType: "text" }]));
    await until(() => Boolean(creation.getState().runs["wb-a"]?.pendingApproval));
    resolveCreationApproval("wb-a", false);
    await until(() => !creation.getState().runs["wb-a"]);
    expect(requests).toHaveLength(1);
    expect(snapshot.nodes.some((node) => node.id === "refused")).toBe(false);
    expect(creation.getState().conversationFor("wb-a")?.progress).toContain("拒绝");
});

test("缺失模型或未恢复会话时同步拒绝，不产生伪运行状态", () => {
    creation.setState({ hydrated: false });
    expect(() => startCreationRun(seed())).toThrow("初始化");
    creation.setState({ hydrated: true });
    config.setState({ config: { ...config.getState().config, promptCloudApis: [] } });
    expect(() => startCreationRun(seed())).toThrow("配置");
    expect(Object.keys(creation.getState().runs)).toHaveLength(0);
    expect(requests).toHaveLength(0);
});

test("重入拒绝，完整任务上下文存入独立历史", async () => {
    const id = startCreationRun(seed());
    expect(() => startCreationRun(seed())).toThrow("正在创作");
    requests[0].resolve(answer("第一轮完成"));
    await until(() => !creation.getState().runs["wb-a"]);
    expect(startCreationRun({ ...seed(), continueExisting: true })).toBe(id);
    expect(requests[1].body.request.messages[1].content).toContain("目标视频时长约 20 秒");
    requests[1].resolve(answer("第二轮完成"));
    await until(() => !creation.getState().runs["wb-a"]);
});

test("错误内容去除共享配置的凭证", async () => {
    startCreationRun(seed());
    requests[0].resolve(new Response(JSON.stringify({ error: { message: "invalid test-only-secret" } }), { status: 400, headers: { "Content-Type": "application/json" } }));
    await until(() => !creation.getState().runs["wb-a"]);
    expect(creation.getState().conversationFor("wb-a")?.lastError).not.toContain("test-only-secret");
    expect(creation.getState().conversationFor("wb-a")?.status).toBe("error");
});

test("同画布上下文瞬时卸载重建不误停；持久化不保留运行锁", async () => {
    startCreationRun(seed());
    canvas.getState().setCanvasContext(null);
    publish();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(requests[0].signal?.aborted).toBe(false);
    const options = creation.persist.getOptions();
    const saved = options.partialize!(creation.getState()) as Record<string, unknown>;
    expect(saved.runs).toBeUndefined();
    requests[0].resolve(answer("上下文刷新后完成"));
    await until(() => !creation.getState().runs["wb-a"]);
});

test("网络请求中停止只取消自己的请求", async () => {
    startCreationRun(seed()); startCreationRun(seed("wb-b"));
    stopCreationRun("wb-a");
    await until(() => !creation.getState().runs["wb-a"]);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    requests[1].resolve(answer("B正常完成"));
    await until(() => !creation.getState().runs["wb-b"]);
});

test("完整十二阶段：实际工具调用推进，素材未完成不能进入分镜，视频最后执行", async () => {
    const cfg = defaultCreationPipeline();
    const files: Record<string, string> = {};
    for (const name of new Set(Object.values(cfg.nodes).flatMap((n) => n.skills))) for (const file of ["SKILL.md", "SKILL.cn.md"]) files[`${name}/${file}`] = Buffer.from(`技能正文 ${name}`).toString("base64");
    pipeline.setState({ files });
    startCreationRun({ ...seed(), createImages: true, createVideos: true });
    let index = 0;
    const invoke = async (name: string, args: unknown = {}) => {
        requests[index].resolve(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }), { headers: { "Content-Type": "application/json" } }));
        index++;
        await until(() => requests.length > index);
        return JSON.parse(requests[index].body.request.messages.at(-1).content);
    };
    const stages = Object.keys(cfg.nodes);
    const plan = {
        assets: [{ id: "char", kind: "character", label: "人物" }, { id: "prop", kind: "prop", label: "灯具" }, { id: "scene", kind: "scene", label: "灯塔" }, { id: "costume", kind: "costume", label: "雨衣", parentId: "char" }, { id: "age", kind: "age", label: "中年", parentId: "char" }],
        shots: [{ id: "shot", label: "点灯", referenceIds: ["costume", "scene", "prop"], promptNodeId: "prompt", videoNodeId: "video" }],
        voiceIds: ["voice"], musicIds: ["music"], omitted: {},
    };
    for (const stage of stages) {
        const skills = await invoke("skill");
        expect(skills.stage).toBe(stage);
        if (stage === "script") expect((await invoke("creation_set_plan", { plan })).ok).toBe(true);
        const image = ["character", "prop", "scene", "costume", "age"].includes(stage);
        const type = image ? "image" : ["voice", "music"].includes(stage) ? "audio" : stage === "pipeline" ? "video" : "text";
        const id = stage === "character" ? "char" : stage === "storyboard" ? "shot" : stage === "video_prompt" ? "prompt" : stage === "pipeline" ? "video" : stage;
        const operations = [{ type: "add_node", id, nodeType: type, metadata: type === "text" ? { content: `${stage}正文` } : { prompt: stage === "pipeline" ? "" : `${stage}生成提示词`, model: "test-media" } }];
        expect((await invoke("canvas_apply_ops", { ops: operations })).ok).toBe(true);
        if (type !== "text") {
            expect((await invoke("creation_complete_stage")).error).toContain("等待真实生成结果");
            expect((await invoke("canvas_apply_ops", { ops: [{ type: "run_generation", nodeId: id, mode: type }] })).ok).toBe(true);
            if (stage === "pipeline") expect(applied.filter(op => op.type === "run_generation").at(-1)).toMatchObject({ nodeId: "video", prompt: "video_prompt正文" });
            // 仅测试替身模拟生成回调，产品中这些字段只能由真实媒体任务更新。
            snapshot = { ...snapshot, nodes: snapshot.nodes.map((n) => n.id === id ? { ...n, metadata: { ...n.metadata, status: "success", content: `blob:test-${id}` } } : n) };
            publish();
        }
        expect((await invoke("creation_complete_stage")).ok).toBe(true);
        expect(snapshot.nodes[0].metadata?.creationPipeline?.completed.at(-1)).toBe(stage);
        if (stage !== "pipeline") {
            requests[index].resolve(answer(`${stage}已完成，请用户继续下一阶段`));
            index++;
            await until(() => requests.length > index);
            expect(requests[index].body.request.messages.at(-1).content).toContain("自动推进");
        }
    }
    expect(snapshot.nodes.some((n) => n.metadata?.workbenchKind === "video-editor")).toBe(true);
    requests[index].resolve(answer("全部阶段通过（受控生成回调）"));
    await until(() => !creation.getState().runs["wb-a"]);
    expect(snapshot.nodes[0].metadata?.creationPipeline?.completed).toHaveLength(12);
});

test("项目聊天允许空原文且不把原文当聊天消息，六档设置写回并保持", async () => {
    const { CREATION_RESOLUTIONS } = await import("../src/lib/agent/creation-settings");
    for (const resolution of CREATION_RESOLUTIONS) {
        const before = requests.length;
        const userMessage = `请解释${resolution}，不要生成`;
        startCreationRun({ ...seed(), idea: resolution === "360p" ? "" : "项目原文不可覆盖", resolution, backgroundMusic: false, style: "", userMessage, continueExisting: true });
        const messages = requests[before].body.request.messages;
        expect(messages.at(-1).content).toBe(userMessage);
        expect(messages[0].content).toContain('当前是项目专属对话');
        expect(messages[0].content).toContain('背景音乐关闭');
        const conversation = creation.getState().conversationFor("wb-a")!;
        expect(conversation.messages.at(-1)?.text).toBe(userMessage);
        expect(conversation.messages.at(-1)?.text).not.toBe("项目原文不可覆盖");
        requests[before].resolve(answer("仅解释，不生成"));
        await until(() => !creation.getState().runs["wb-a"]);
        expect(snapshot.nodes).toHaveLength(2);
        expect(snapshot.nodes[0].metadata?.agentCreation).toMatchObject({ resolution, backgroundMusic: false, idea: resolution === "360p" ? "" : "项目原文不可覆盖", style: "" });
    }
});

test("启动不把全文粘进用户聊天历史", async () => {
    startCreationRun(seed());
    expect(creation.getState().conversationFor("wb-a")?.messages[0].text).toBe("按项目资料启动创作");
    expect(requests[0].body.request.messages[0].content).toContain(seed().idea);
    requests[0].resolve(answer("已收到"));
    await until(() => !creation.getState().runs["wb-a"]);
});

test("项目聊天执行层拒绝模型越权写入", async () => {
    startCreationRun({ ...seed(), userMessage: "解释一下项目", continueExisting: true });
    expect(requests[0].body.request.tools.some((tool: any) => tool.function.name === "canvas_apply_ops")).toBe(false);
    requests[0].resolve(tools([{ type: "add_node", id: "unasked-output", nodeType: "text", metadata: { content: "不应写入" } }]));
    await until(() => requests.length === 2);
    expect(requests[1].body.request.messages.at(-1).content).toContain("只读讨论");
    expect(snapshot.nodes.some((n) => n.id === "unasked-output")).toBe(false);
    requests[1].resolve(answer("只解释，不改画布"));
    await until(() => !creation.getState().runs["wb-a"]);
});

test("媒体续跑仅收到口头执行描述时最多纠正一次，不伪报提交", async () => {
    startCreationRun({ ...seed(), createImages: true });
    requests[0].resolve(answer("配乐任务已提交，仍在generating，我继续等待。"));
    await until(() => requests.length === 2);
    expect(requests[1].body.request.messages.at(-1).content).toContain("没有发生操作");
    requests[1].resolve(answer("配乐仍在生成中，我继续等待。"));
    await until(() => !creation.getState().runs["wb-a"]);
    expect(requests).toHaveLength(2);
    expect(applied.filter(op => op.type === "run_generation")).toHaveLength(0);
    expect(creation.getState().conversationFor("wb-a")?.lastError).toContain("没有实际操作调用");
    expect(creation.getState().conversationFor("wb-a")?.messages.some(m => m.text === "配乐任务已提交，仍在generating，我继续等待。")).toBe(false);
});

test("幽灵音乐loading没有活动请求时立即停止等待，不再请求云端", async () => {
    const { CREATION_STAGES } = await import("../src/lib/agent/creation-pipeline");
    snapshot.nodes[0].metadata!.creationPipeline = { version: 1, render: true, completed: CREATION_STAGES.slice(0,10).map(s=>s.id), plan: { assets: [], shots: [], voiceIds: [], musicIds: ["music-storm-night"], omitted: {} } };
    snapshot.nodes.push({ id:"music-storm-night",type:"audio",title:"风雨夜配乐",position:{x:0,y:300},width:300,height:100,metadata:{status:"loading",prompt:"纯器乐",creationOutput:{projectNodeId:"wb-a",stage:"music"}} });
    activeIds = new Set();
    publish();
    startCreationRun({ ...seed(), createImages:true, continueExisting:true });
    await until(()=>!creation.getState().runs["wb-a"]);
    expect(requests).toHaveLength(0);
    expect(creation.getState().conversationFor("wb-a")?.lastError).toContain("没有活动生成请求");
    expect(snapshot.nodes.find(n=>n.id==="music-storm-night")?.metadata?.status).toBe("loading");
});

function prepareAutoMusic() {
    const cfg=defaultCreationPipeline();const files:Record<string,string>={};
    for(const name of new Set(Object.values(cfg.nodes).flatMap(n=>n.skills)))for(const file of ["SKILL.md","SKILL.cn.md"])files[`${name}/${file}`]=Buffer.from(`测试技能 ${name}`).toString("base64");
    pipeline.setState({files});
    const contentNode = (id:string,stage:string,type="text") => ({id,type,title:id,position:{x:0,y:0},width:200,height:100,metadata:{status:"success",content:type==="image"?"blob:fixture-image":"已确认正文",creationOutput:{projectNodeId:"wb-a",stage}}});
    const completed=["novel","script","character","prop","scene","costume","age","voice","storyboard","video_prompt"];
    snapshot.nodes[0].metadata!.creationPipeline = {version:1,render:true,videos:true,backgroundMusic:true,completed,plan:{assets:[{id:"person",kind:"character",label:"人物"}],shots:[{id:"shot",label:"镜头",referenceIds:["person"],promptNodeId:"prompt",videoNodeId:"video"}],voiceIds:[],musicIds:["music"],omitted:{prop:"无",scene:"无",costume:"无",age:"无",voice:"无"}}} as any;
    snapshot.nodes.push(contentNode("novel","novel") as any,contentNode("script","script") as any,contentNode("person","character","image") as any,contentNode("shot","storyboard") as any,contentNode("prompt","video_prompt") as any,{...contentNode("music","music","audio"),metadata:{status:"loading",prompt:"纯器乐",creationOutput:{projectNodeId:"wb-a",stage:"music"}}} as any);
    activeIds=new Set(["music"]);publish();
}
function settleMusic(status:"success"|"error") {
    activeIds!.delete("music");snapshot={...snapshot,nodes:snapshot.nodes.map(n=>n.id==="music"?{...n,metadata:{...n.metadata,status,...(status==="success"?{content:"blob:music",storageKey:"audio:music"}:{errorDetails:"测试配乐失败"})}}:n)};publish();
}
const toolReply=(name:string)=>new Response(JSON.stringify({choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"test-tool",type:"function",function:{name,arguments:"{}"}}]}}]}),{headers:{"Content-Type":"application/json"}});

test("媒体等待期间零云请求，成功后自动完成音乐并进入视频阶段",async()=>{
    prepareAutoMusic();startCreationRun({...seed(),createImages:true,createVideos:true,continueExisting:true});
    expect(requests).toHaveLength(0);expect(creation.getState().runs["wb-a"].phase).toBe("waiting_media");
    for(let i=0;i<5;i++)publish();
    await new Promise<void>(r=>queueMicrotask(r));expect(requests).toHaveLength(0);
    settleMusic("success");await until(()=>requests.length===1);
    requests[0].resolve(toolReply("skill"));await until(()=>requests.length===2);
    requests[1].resolve(answer("本阶段完成，请继续"));await until(()=>requests.length===3);
    expect(snapshot.nodes[0].metadata!.creationPipeline!.completed).toContain("music");
    expect(requests[2].body.request.messages.at(-1).content).toContain("总流水线");
    expect(creation.getState().runs["wb-a"].phase).toBe("executing");
    expect(applied.filter(o=>o.type==="run_generation")).toHaveLength(0);
    stopCreationRun("wb-a");await until(()=>!creation.getState().runs["wb-a"]);
});
test("等待中停止后结果返回不自动重启且不取消媒体",async()=>{
    prepareAutoMusic();startCreationRun({...seed(),createImages:true,createVideos:true});
    expect(creation.getState().runs["wb-a"].phase).toBe("waiting_media");stopCreationRun("wb-a");
    await until(()=>!creation.getState().runs["wb-a"]);
    expect(activeIds!.has("music")).toBe(true);
    settleMusic("success");await new Promise<void>(r=>queueMicrotask(r));
    expect(requests).toHaveLength(0);expect(creation.getState().runs["wb-a"]).toBeUndefined();
    expect(snapshot.nodes[0].metadata!.creationPipeline!.completed).not.toContain("music");
});
test("媒体失败后自动暂停，不调用云模型重试或推进阶段",async()=>{
    prepareAutoMusic();startCreationRun({...seed(),createImages:true,createVideos:true});
    settleMusic("error");await until(()=>!creation.getState().runs["wb-a"]);
    expect(requests).toHaveLength(0);expect(creation.getState().conversationFor("wb-a")?.lastError).toContain("测试配乐失败");
    expect(snapshot.nodes[0].metadata!.creationPipeline!.completed).not.toContain("music");
});
test("等待时切换画布释放订阅，迟到结果不自动请求模型",async()=>{
    prepareAutoMusic();startCreationRun({...seed(),createImages:true,createVideos:true});
    snapshot={...snapshot,projectId:"canvas-b",nodes:[]};publish();
    await until(()=>!creation.getState().runs["wb-a"]);
    expect(requests).toHaveLength(0);expect(snapshot.nodes).toHaveLength(0);
});
test("文本阶段完成后不需手动确认即自动进入剧本",async()=>{
    startCreationRun(seed());requests[0].resolve(tools([{type:"add_node",id:"novel",nodeType:"text",metadata:{content:"已完成小说"}}]));
    await until(()=>requests.length===2);requests[1].resolve(answer("小说已完成，请继续下一步"));
    await until(()=>requests.length===3);
    expect(snapshot.nodes[0].metadata!.creationPipeline!.completed).toEqual(["novel"]);
    expect(requests[2].body.request.messages.at(-1).content).toContain("生成剧本");
    stopCreationRun("wb-a");await until(()=>!creation.getState().runs["wb-a"]);
});

test("共享配置结构和独立启动入口不回退", () => {
    for (const path of ["src/lib/agent/creation-agent-runtime.ts", "src/components/agent/agent-cloud-chat.tsx"]) expect(readFileSync(path, "utf8")).toContain("activePromptCloudApi");
    const host = readFileSync("src/components/canvas/workbench-node-content.tsx", "utf8");
    expect(host).toContain("startCreationRun");
    expect(host).not.toContain("agent.openPanel()");
    expect(host).not.toContain("setAgentState({");
});

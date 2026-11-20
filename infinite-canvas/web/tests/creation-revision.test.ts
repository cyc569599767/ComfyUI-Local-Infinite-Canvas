import { expect, test } from "bun:test";
import { applyCreationRevision } from "../src/lib/agent/creation-revision";
import { creationOutputName } from "../src/lib/agent/creation-output-names";
import { CREATION_STAGES, guardCreationOps, inspectCreationStage, type CreationStageId } from "../src/lib/agent/creation-pipeline";
import { collectTimelineSources } from "../src/lib/canvas/video-timeline";
import type { CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";
import type { CanvasNodeData } from "../src/types/canvas";
function node(id: string, stage: CreationStageId, type = "image"): CanvasNodeData {
    return {id,type,title:id,position:{x:0,y:0},width:300,height:200,metadata:{status:"success",content:type === "text" ? "原正文" : `https://fixture/${id}.png`,prompt:"原提示词",creationOutput:{projectNodeId:"host",stage}}};
}
function fixture(): CanvasAgentSnapshot {
    const host: CanvasNodeData={id:"host",type:"workbench",title:"故事",position:{x:0,y:0},width:300,height:200,metadata:{workbenchKind:"agent-creation",agentCreation:{idea:"故事",style:"",aspectRatio:"16:9",targetSeconds:30,createImages:true,createVideos:true,resolution:"1080p",backgroundMusic:true,status:"ready"},creationPipeline:{version:1,render:true,videos:true,completed:CREATION_STAGES.map(s=>s.id),plan:{assets:[{id:"person",kind:"character",label:"人物"},{id:"costume",kind:"costume",label:"换装",parentId:"person"},{id:"scene",kind:"scene",label:"场景"}],shots:[{id:"shot",label:"镜头",referenceIds:["person","costume"],promptNodeId:"prompt",videoNodeId:"video"}],voiceIds:["voice"],musicIds:["music"],omitted:{prop:"无",age:"无"}}}}};
    return {projectId:"canvas",title:"画布",nodes:[host,node("novel","novel","text"),node("script","script","text"),node("person","character"),node("costume","costume"),node("scene","scene"),node("shot","storyboard","text"),node("prompt","video_prompt","text"),node("video","pipeline","video"),node("voice","voice","audio"),node("music","music","audio")],connections:[{id:"r1",fromNodeId:"person",toNodeId:"video"},{id:"r2",fromNodeId:"costume",toNodeId:"video"}],viewport:{x:0,y:0,k:1},selectedNodeIds:[]};
}
const state=(s:CanvasAgentSnapshot)=>s.nodes[0].metadata!.creationPipeline!;
const request=(s:CanvasAgentSnapshot,sourceNodeId="person",feedback="改为蓝色衣服")=>applyCreationRevision(s,"host",{action:"request",sourceNodeId,candidateNodeId:"new",feedback,createdAt:1});
const succeed=(s:CanvasAgentSnapshot)=>({...s,nodes:s.nodes.map(n=>n.id==="new"?{...n,metadata:{...n.metadata,status:"success" as const,content:"https://fixture/new.png",storageKey:"new-key"}}:n)});

test("重做保留旧结果、随机种子、固定专用工作流、等待采用",()=>{
 const original=fixture();const s=request(original);const candidate=s.nodes.at(-1)!;
 expect(s.nodes.find(n=>n.id==="person")!.metadata!.content).toBe("https://fixture/person.png");
 expect(candidate.metadata!.content).toBeUndefined();expect(candidate.metadata!.prompt).toContain("改为蓝色衣服");
 expect(candidate.metadata!.model).toBe("local-gateway::creation-image-krea2");expect(candidate.metadata!.seedFixed).toBe("false");
 expect(inspectCreationStage("character",state(s),s.nodes,"host").ready).toBe(false);
 expect(()=>guardCreationOps([],s.nodes,"host",state(s))).toThrow("确认");expect(state(original).review).toBeUndefined();
});
test("采用新版保持正式ID及连线，保留历史，仅标记依赖分支并回退阶段",()=>{
 const s=applyCreationRevision(succeed(request(fixture())),"host",{action:"accept",historyNodeId:"old"});
 expect(s.nodes.find(n=>n.id==="person")!.metadata!.content).toBe("https://fixture/new.png");
 expect(s.nodes.find(n=>n.id==="old")!.metadata!.content).toBe("https://fixture/person.png");
 expect(creationOutputName(s.nodes.find(n=>n.id==="old")!,s.nodes)).toBe("人物 · 历史版本");
 expect(creationOutputName(s.nodes.find(n=>n.id==="new")!,s.nodes)).toBe("人物 · 已采用记录");
 for(const id of ["costume","shot","prompt","video"])expect(s.nodes.find(n=>n.id===id)!.metadata!.creationOutput!.needsRevision).toBe(true);
 expect(s.nodes.find(n=>n.id==="scene")!.metadata!.creationOutput!.needsRevision).toBeUndefined();
 expect(state(s).completed).toEqual(["novel","script"]);expect(state(s).review).toBeUndefined();
 expect(s.connections.slice(0,2)).toEqual(fixture().connections);
 expect(collectTimelineSources(s.nodes)).toEqual([]);
});
test("取消候选保持原素材和原阶段，失败不允许采用",()=>{
 const s=request(fixture());expect(()=>applyCreationRevision(s,"host",{action:"accept",historyNodeId:"old"})).toThrow("仍有媒体");
 s.nodes.find(n=>n.id==="new")!.metadata!.status="error";
 expect(()=>applyCreationRevision(s,"host",{action:"accept",historyNodeId:"old"})).toThrow("尚未");
 const canceled=applyCreationRevision(s,"host",{action:"discard"});expect(state(canceled).completed).toHaveLength(12);
 expect(canceled.nodes.find(n=>n.id==="person")!.metadata!.content).toContain("person.png");
 expect(canceled.nodes.at(-1)!.metadata!.creationOutput!.revisionKind).toBe("discarded");
});
test("生成中、跨项目、历史结果、空反馈、重复请求均不写入",()=>{
 const s=fixture();s.nodes[2].metadata!.status="loading";expect(()=>request(s)).toThrow("仍有媒体");
 expect(()=>request(fixture(),"host")).toThrow("只能重做");expect(()=>request(fixture(),"person"," ")).toThrow("修改要求");
 expect(()=>request(request(fixture()))).toThrow("仍有媒体");
 const foreign=fixture();foreign.nodes.find(n=>n.id==="person")!.metadata!.creationOutput!.projectNodeId="other";expect(()=>request(foreign)).toThrow("本项目");
});
test("视频用最新提示词及原计划参考顺序，不拿旧结果作参考",()=>{
 const s=fixture();s.nodes.find(n=>n.id==="prompt")!.metadata!.content="最新视频正文";
 const r=request(s,"video");expect(r.nodes.at(-1)!.metadata!.prompt).toContain("最新视频正文");
 expect(r.nodes.at(-1)!.metadata!.model).toContain("creation-video-h3-1080");
 expect(r.connections.filter(c=>c.toNodeId==="new").map(c=>c.fromNodeId)).toEqual(["person","costume"]);
});
test("音色反馈改描述不朗读反馈，关闭配乐禁止重做音乐",()=>{
 const r=request(fixture(),"voice","声音更低沉");expect(r.nodes.at(-1)!.metadata!.prompt).toBe("原提示词");expect(r.nodes.at(-1)!.metadata!.audioVoiceDescription).toContain("声音更低沉");
 const s=fixture();s.nodes[0].metadata!.agentCreation!.backgroundMusic=false;expect(()=>request(s,"music")).toThrow("关闭背景音乐");
});
test("候选待提交即加媒体锁，依赖变化阻止采用，丢失候选可取消",()=>{
 const s=request(fixture(),"video");
 expect(s.nodes.at(-1)!.metadata!.status).toBe("loading");
 expect(()=>applyCreationRevision(s,"host",{action:"discard"})).toThrow("仍有媒体");
 const ready=succeed(s);ready.nodes.find(n=>n.id==="prompt")!.metadata!.content="候选提交后另改的提示词";
 expect(()=>applyCreationRevision(ready,"host",{action:"accept",historyNodeId:"old"})).toThrow("参考内容已变化");
 const missing={...ready,nodes:ready.nodes.filter(n=>n.id!=="new")};
 expect(state(applyCreationRevision(missing,"host",{action:"discard"})).review).toBeUndefined();
});

test("稳定storageKey允许刷新blobURL后采用，历史音视频不会入剪辑台",()=>{
 const f=fixture();f.nodes.find(n=>n.id==="person")!.metadata!.storageKey="original-key";
 const s=succeed(request(f));s.nodes.find(n=>n.id==="person")!.metadata!.content="blob:new-session";
 const accepted=applyCreationRevision(s,"host",{action:"accept",historyNodeId:"old"});
 expect(accepted.nodes.find(n=>n.id==="old")!.metadata!.storageKey).toBe("original-key");
 const v=succeed(request(fixture(),"video"));
 const result=applyCreationRevision(v,"host",{action:"accept",historyNodeId:"old-video"});
 expect(collectTimelineSources(result.nodes).map(n=>n.nodeId)).toEqual(["video"]);
});

test("失效文本更新后可恢复，失效媒体不能被Agent覆盖",()=>{
 const s=applyCreationRevision(succeed(request(fixture())),"host",{action:"accept",historyNodeId:"old"});
 const p=state(s);p.completed=CREATION_STAGES.slice(0,8).map(s=>s.id);
 s.nodes.find(n=>n.id==="costume")!.metadata!.creationOutput!.needsRevision=false;
 const ops=guardCreationOps([{type:"update_node",id:"shot",metadata:{content:"按新版重写"}}],s.nodes,"host",p);
 expect(ops[0].type==="update_node"&&ops[0].metadata!.creationOutput!.needsRevision).toBe(false);
});

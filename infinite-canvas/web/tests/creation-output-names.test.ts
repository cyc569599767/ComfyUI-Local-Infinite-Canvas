import { expect, test } from "bun:test";
import { creationAssetDownloadName, creationOutputName, creationPlanName, creationDownloadName, safeCreationName } from "../src/lib/agent/creation-output-names";
import { guardCreationOps, validateCreationPlan, type CreationPlan, type CreationStageId } from "../src/lib/agent/creation-pipeline";
import type { CanvasNodeData } from "../src/types/canvas";
const plan:CreationPlan={assets:[{id:"person",kind:"character",label:"陆明"},{id:"key",kind:"prop",label:"古铜钥匙"},{id:"tower",kind:"scene",label:"海边灯塔"},{id:"coat",kind:"costume",label:"蓝色外套",parentId:"person"}],shots:[{id:"shot",label:"灯塔重逢",referenceIds:["person"],promptNodeId:"prompt",videoNodeId:"video"}],voiceIds:["voice"],musicIds:["music"],outputNames:{voice:"陆明-音色",music:"灯塔主题配乐"},omitted:{age:"无"}};
function node(id:string,stage:CreationStageId):CanvasNodeData{return {id,type:"image",title:"A cinematic portrait wearing long",position:{x:0,y:0},width:300,height:200,metadata:{prompt:"A cinematic portrait wearing long coat in high detail",creationOutput:{projectNodeId:"wb",stage}}};}
const host:CanvasNodeData={...node("wb","script"),type:"workbench",metadata:{workbenchKind:"agent-creation",creationPipeline:{version:1,completed:[],plan}}};
test("人物物品场景和变体均从计划名称解析而不是提示词",()=>{
 for(const [id,stage,name] of [["person","character","陆明"],["key","prop","古铜钥匙"],["tower","scene","海边灯塔"],["coat","costume","陆明-蓝色外套"]] as const){expect(creationPlanName(plan,id,stage)).toBe(name);expect(creationOutputName(node(id,stage),[host])).toBe(name);}
 expect(creationPlanName(plan,"video","pipeline")).toBe("灯塔重逢-视频");expect(creationPlanName(plan,"voice","voice")).toBe("陆明-音色");expect(creationPlanName(plan,"music","music")).toBe("灯塔主题配乐");
});
test("老标题为提示词时不回退提示词，独立导出保留持久语义名",()=>{
 const old=node("missing","character");expect(creationOutputName(old)).toBe("人物-missing");
 old.metadata!.creationOutput!.name="陆明";expect(creationOutputName(old)).toBe("陆明");
 expect(creationOutputName({...old,metadata:{prompt:"普通节点"}})).toBeUndefined();
});
test("候选历史名称回溯原素材，后缀不重复，下载名称可区分",()=>{
 const candidate=node("revision-one","character");candidate.metadata!.creationOutput={projectNodeId:"wb",stage:"character",name:"陆明",revisionOf:"person",revisionKind:"candidate"};
 expect(creationOutputName(candidate,[host])).toBe("陆明 · 待确认新版");
 candidate.title="陆明 · 待确认新版";expect(creationOutputName(candidate)).toBe("陆明 · 待确认新版");
 expect(creationDownloadName(candidate,[host],"png")).toMatch(/^陆明 · 待确认新版_.+\.png$/);
 expect(creationDownloadName({...candidate,id:"revision-two"},[host],"png")).not.toBe(creationDownloadName(candidate,[host],"png"));
});
test("名称清理路径控制符保留中文并限制长度及Windows保留名",()=>{
 expect(safeCreationName('../陆明\\蓝衣:*?%\n')).not.toMatch(/[\\/:*?%\n]/);expect(safeCreationName('CON')).toBe('_CON');expect(safeCreationName('...')).toBe('素材');expect(Array.from(safeCreationName('灯'.repeat(200))).length).toBe(80);
});
test("素材库下载带唯一标识并保留中文，非创作资产不改名",()=>{
 const asset={id:"asset-one",title:"陆明 · 历史版本",metadata:{creationOutput:{stage:"character"}}};
 expect(creationAssetDownloadName(asset,"png")).toBe("陆明 · 历史版本_asset-one.png");
 expect(creationAssetDownloadName({...asset,id:"asset-two"},"png")).not.toBe(creationAssetDownloadName(asset,"png"));
 expect(creationAssetDownloadName({...asset,metadata:{}},"png")).toBeUndefined();
});
test("已采用记录与旧版历史的名称区分在重复布局后保持",()=>{
 const history=node("old","character");history.metadata!.creationOutput={projectNodeId:"wb",stage:"character",name:"陆明",revisionOf:"person",revisionKind:"history"};
 expect(creationOutputName(history,[host])).toBe("陆明 · 历史版本");
 history.metadata!.creationOutput!.revisionAccepted=true;
 history.title=creationOutputName(history,[host])!;
 expect(creationOutputName(history,[host])).toBe("陆明 · 已采用记录");
 delete history.metadata!.creationOutput!.revisionAccepted;
 expect(creationOutputName(history,[host])).toBe("陆明 · 已采用记录");
});
test("Agent建卡强制计划名并将名称写入metadata，非法outputNames被拒绝",()=>{
 const state={version:1 as const,completed:["novel","script"] as CreationStageId[],plan};
 const text=(id:string,stage:CreationStageId)=>({...node(id,stage),type:"text",metadata:{content:"正文",creationOutput:{projectNodeId:"wb",stage}}});
 const ops=guardCreationOps([{type:"add_node",id:"person",nodeType:"image",title:"A cinematic portrait...",metadata:{prompt:"A cinematic portrait..."}}],[text("novel","novel"),text("script","script")],"wb",state);
 expect(ops[0].type==='add_node'&&ops[0].title).toBe('陆明');expect(ops[0].type==='add_node'&&ops[0].metadata?.creationOutput?.name).toBe('陆明');
 expect(()=>validateCreationPlan({...plan,outputNames:{wrong:"不是计划ID"}})).toThrow('outputNames');
});

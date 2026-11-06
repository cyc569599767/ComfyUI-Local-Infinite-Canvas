'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {regenerationPlan,deleteHistoryMessage,rebuildChatHistory,requiresUnavailableAttachments,persistChatMessage}=require('../../infinite-canvas/web/src/lib/agent-chat-history.ts');
const history=[{id:'u1',role:'user',text:'First',turnId:'u1'},{id:'a1',role:'assistant',text:'Old answer',turnId:'u1'},{id:'u2',role:'user',text:'Second',turnId:'u2'},{id:'a2',role:'assistant',text:'Last',turnId:'u2'}];
test('regenerate user and AI target the same turn, removing that answer and later history',()=>{
 for(const id of ['u1','a1']){const p=regenerationPlan(history,id);assert.equal(p.user.id,'u1');assert.deepEqual(p.prefix,[]);assert.deepEqual(p.removed,history);}
 for(const id of ['u2','a2']){const p=regenerationPlan(history,id);assert.equal(p.user.id,'u2');assert.deepEqual(p.prefix,history.slice(0,2));}
 assert.equal(regenerationPlan(history,'missing'),null);
 assert.equal(history.length,4);
});
test('deleting an AI reply removes it and every later message, keeping its preceding user prompt',()=>{
 const result=deleteHistoryMessage(history,'a1');assert.deepEqual(result.map(x=>x.id),['u1']);
 assert.deepEqual(rebuildChatHistory(result,()=>undefined),[{role:'user',content:'First'}]);
 assert.equal(history.length,4);assert.equal(result[0],history[0]);
});
test('deleting a user message removes that prompt and all subsequent replies and turns',()=>{
 const result=deleteHistoryMessage(history,'u2');assert.deepEqual(result,history.slice(0,2));
 assert.deepEqual(rebuildChatHistory(result,()=>undefined),[{role:'user',content:'First'},{role:'assistant',content:'Old answer'}]);
 assert.equal(regenerationPlan(result,'a2'),null);
 assert.deepEqual(deleteHistoryMessage(history,'u1'),[]);
 assert.deepEqual(deleteHistoryMessage(history,'a2'),history.slice(0,3));
});
test('missing selectors are no-ops and trailing tools/errors/status entries are removed too',()=>{
 assert.equal(deleteHistoryMessage(history,'missing'),history);
 const mixed=[...history,{id:'tool',role:'tool',text:'result'},{id:'err',role:'error',text:'error'},{id:'sys',role:'system',text:'stopped'}];
 assert.deepEqual(deleteHistoryMessage(mixed,'a1'),history.slice(0,1));
 const empty=[];assert.equal(deleteHistoryMessage(empty,'none'),empty);
 const saved=JSON.parse(JSON.stringify(deleteHistoryMessage(mixed,'u2').map(persistChatMessage)));
 assert.deepEqual(saved.map(x=>x.id),['u1','a1']);
 assert.equal(JSON.stringify(saved).includes('Second'),false);
});
test('legacy history is truncated without changing earlier messages or guessing a new prompt',()=>{
 const old=history.map(({turnId,...m})=>m);assert.equal(regenerationPlan(old,'a2').user.id,'u2');
 const result=deleteHistoryMessage(old,'u2');assert.deepEqual(result,old.slice(0,2));assert.equal(regenerationPlan(result,'a2'),null);
 assert.equal(regenerationPlan([{id:'a',role:'assistant',text:'orphan'}],'a'),null);
 assert.equal(regenerationPlan([{id:'x',role:'error',text:'error'}],'x'),null);
});
test('image replay preserves available attachments but rejects silent text-only replay of expired images',()=>{
 const m={id:'u-image',role:'user',text:'发送了 1 张图片',promptText:'',hasAttachments:true,attachments:[{id:'im',name:'test.png',url:'blob:test'}]};
 assert.equal(requiresUnavailableAttachments(m),true);const image={dataUrl:'data:image/png;base64,dGVzdA=='};
 assert.equal(requiresUnavailableAttachments(m,[image]),false);
 const api=rebuildChatHistory([m],()=>[image]);assert.equal(api[0].content[1].image_url.url,image.dataUrl);
 assert.match(rebuildChatHistory([m],()=>undefined)[0].content,/图片已不可用/);
 const stored=persistChatMessage({...m,apiKey:'must-not-save',streamId:'s',provider_metadata:{secret:'x'}});
 assert.equal(stored.hasAttachments,true);assert.equal(stored.promptText,'');
 for(const key of ['attachments','apiKey','streamId','provider_metadata'])assert.equal(key in stored,false,key);
});
test('reconstructed history discards dangling tool pairs, errors and empty partial output',()=>{
 const result=rebuildChatHistory([...history,{id:'tool',role:'tool',text:'old result'},{id:'err',role:'error',text:'error'},{id:'partial',role:'assistant',text:''}],()=>undefined);
 assert.equal(result.length,4);assert.ok(result.every(x=>x.role==='user'||x.role==='assistant'));
});

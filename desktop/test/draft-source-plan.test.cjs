'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {resolveDraftSourcePlan:plan}=require('../../infinite-canvas/web/src/lib/canvas/draft-source-plan.ts');
const {buildGeneratedNodeConnections:links}=require('../../infinite-canvas/web/src/lib/canvas/generation-connections.ts');
const images=['image-a','image-b','image-c'].map(id=>({id,name:id+'.png',type:'image/png',dataUrl:'data:image/png;base64,eA=='}));
test('source text mode remains text with a connected picture while retaining the direct canvas edge',()=>{
 const nodes=[{id:'image-a',type:'image'},{id:'original',type:'video',metadata:{videoMode:'text',status:'idle'}}];
 const existing=[{id:'reference',fromNodeId:'image-a',toNodeId:'original'}];
 const p=plan('text',undefined,[images[0]]);assert.equal(p.mode,'text');assert.equal(p.frameMode,undefined);assert.equal(p.images.length,0);assert.equal(p.requiredImageCount,0);
 const chosen=new Set(p.connectionImages.map(x=>x.id));const inputs=[{nodeId:'image-a',type:'image',title:'Ref',image:images[0]}].filter(x=>chosen.has(x.nodeId));
 assert.deepEqual(links('original','draft',inputs,nodes,existing,()=> 'draft-reference'),[{id:'draft-reference',fromNodeId:'image-a',toNodeId:'draft'}]);assert.equal(existing.length,1);
});
test('text mode never becomes frames due to image count or a stale frame option',()=>{
 for(const refs of [[],images.slice(0,1),images.slice(0,2),images]){const p=plan('text','last',refs);assert.equal(p.mode,'text');assert.equal(p.frameMode,undefined);assert.deepEqual(p.images,[]);assert.deepEqual(p.connectionImages,refs);}
});
test('explicit first last and both selections remain unchanged',()=>{
 for(const frameMode of ['first','last','both']){const p=plan('frames',frameMode,images);assert.equal(p.mode,'frames');assert.equal(p.frameMode,frameMode);assert.equal(p.images.length,frameMode==='both'?2:1);assert.deepEqual(p.connectionImages,p.images);assert.equal(p.requiredImageCount,frameMode==='both'?2:1);}
});
test('frame mode without a selection uses the existing image-count frame default, not a different task mode',()=>{
 assert.equal(plan('frames',undefined,[images[0]]).frameMode,'first');assert.equal(plan('frames',undefined,images).frameMode,'both');
});
test('multi-reference keeps mode and original source IDs before compression',()=>{
 const p=plan('reference','last',images,2);assert.equal(p.mode,'reference');assert.deepEqual(p.images.map(x=>x.id),['image-a','image-b']);assert.deepEqual(p.connectionImages,p.images);assert.equal(p.frameMode,undefined);assert.equal(p.requiredImageCount,1);
});
test('missing inputs never downgrade frame/reference mode to text',()=>{
 for(const mode of ['frames','reference']){const p=plan(mode,'both',[]);assert.equal(p.mode,mode);assert.equal(p.images.length,0);assert.ok(p.requiredImageCount>0);}
 const p=plan('frames','both',[images[0]]);assert.equal(p.mode,'frames');assert.equal(p.frameMode,'both');assert.equal(p.images.length,1);assert.equal(p.requiredImageCount,2);
});
test('source planning leaves original arrays unchanged and text plans separate request images from connections',()=>{
 const before=JSON.stringify(images);for(const mode of ['text','frames','reference'])plan(mode,'last',images);assert.equal(JSON.stringify(images),before);
 const p=plan('text',undefined,images);p.connectionImages.pop();assert.equal(images.length,3);assert.equal(p.images.length,0);
});

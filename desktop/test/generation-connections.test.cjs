'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {buildGeneratedNodeConnections:build}=require('../../infinite-canvas/web/src/lib/canvas/generation-connections.ts');
const node=(id,type='image',metadata={})=>({id,type,title:id,position:{x:0,y:0},width:100,height:100,metadata});
const input=(nodeId,type='image')=>({nodeId,type,title:nodeId});
function links(source,target,inputs,nodes,edges=[],options={}){let n=0;return build(source,target,inputs,nodes,edges,()=>`edge-${++n}`,options);}
test('image video audio and text regenerated results bypass the prior result',()=>{
 for(const kind of ['image','video','audio','text']){
  const nodes=[node('ref'),node('prompt','text'),node('old',kind),node('new',kind)];
  const edges=[{id:'original',fromNodeId:'ref',toNodeId:'old'}];
  const fresh=links('old','new',[input('ref'),input('prompt','text')],nodes,edges);
  assert.deepEqual(fresh.map(e=>[e.fromNodeId,e.toNodeId]),[['ref','new'],['prompt','new']]);
  assert.ok(fresh.every(e=>!e.role));assert.equal(new Set(fresh.map(e=>e.id)).size,2);assert.deepEqual(edges,[{id:'original',fromNodeId:'ref',toNodeId:'old'}]);
 }
});
test('group resources are directly connected in generation order and deduplicated',()=>{
 const nodes=['one','two','group','old','new'].map(id=>node(id));
 const sources=[{nodeId:'group',type:'group',title:'Group',children:[input('two'),input('one')]},input('two')];
 assert.deepEqual(links('old','new',sources,nodes).map(e=>e.fromNodeId),['two','one']);
});
test('no references produces an independent result, not an artificial parent connection',()=>{
 assert.deepEqual(links('old','new',[],[node('old'),node('new')]),[]);
});
test('repeat generation keeps same upstream resources without forming a chain',()=>{
 const nodes=['one','two','old','new','third'].map(id=>node(id));
 const first=links('old','new',[input('one'),input('two')],nodes);
 const second=links('new','third',first.map(e=>input(e.fromNodeId)),nodes,first);
 assert.deepEqual(second.map(e=>e.fromNodeId),['one','two']);assert.ok(!second.some(e=>e.fromNodeId==='old'||e.fromNodeId==='new'));
});
test('overwrite is a no-op; stale resources, self links and duplicate target inputs are excluded',()=>{
 const nodes=['one','old','new'].map(id=>node(id));
 assert.deepEqual(links('old','old',[input('one')],nodes),[]);
 assert.deepEqual(links('old','new',[input('old'),input('new'),input('missing'),input('one')],nodes,[{id:'already',fromNodeId:'one',toNodeId:'new'}]),[]);
});
test('legacy stored image references match live nodes in stored order without inventing missing nodes',()=>{
 const nodes=[node('one','image',{content:'blob:one',storageKey:'image:one'}),node('two','image',{images:[{content:'blob:two',storageKey:'image:two'}]}),node('old','image',{content:'blob:old'}),node('other','video',{content:'blob:other'})];
 const edges=links('old','new',[input('one')],nodes,[],{referenceUrls:['image:two','image:one','blob:old','missing','blob:other']});
 assert.deepEqual(edges.map(e=>e.fromNodeId),['two','one']);
});
test('draft can limit inputs to only accepted images and text, dropping video audio and LoRA',()=>{
 const nodes=['image','text','video','audio','lora','old'].map(id=>node(id,id));
 const inputs=['image','text','video','audio','lora'].map(id=>input(id,id));
 assert.deepEqual(links('old','new',inputs,nodes,[],{kinds:['image','text']}).map(e=>e.fromNodeId),['image','text']);
});
test('existing lineage does not suppress a real resource edge',()=>{
 assert.equal(links('old','new',[input('ref')],[node('ref'),node('old')],[{id:'lineage',fromNodeId:'ref',toNodeId:'new',role:'lineage'}]).length,1);
});

'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {hasNodeInteractionContent:has,nodeInteractionState:state}=require('../../infinite-canvas/web/src/lib/canvas/node-interaction.ts');
const def={interactionToggle:true};
const node=(type,metadata)=>({id:'n',type,metadata});
test('3D model with only a model URL gets the interaction/move toggle',()=>{
 for(const format of ['ply','glb']){const n=node('model3d',{model3d:{url:'fixture.'+format,format},interactive:true});assert.equal(has(n),true);assert.deepEqual(state(n,def),{toggleEnabled:true,contentInteractive:true});}
});
test('3D move mode disables viewer input even without metadata.content',()=>{
 const n=node('model3d',{model3d:{url:'fixture.ply'},interactive:false});assert.deepEqual(state(n,def),{toggleEnabled:true,contentInteractive:false});
});
test('3D stage scene URL participates in move and interaction modes',()=>{
 const n=node('stage3d',{stage3d:{scene:{url:'scene.glb'}},interactive:false});assert.equal(has(n),true);assert.equal(state(n,def).contentInteractive,false);n.metadata.interactive=true;assert.equal(state(n,def).contentInteractive,true);
});
test('loading empty and failed nodes remain usable even without resource content',()=>{
 for(const status of ['loading','idle','error']){const n=node('model3d',{status,interactive:false});assert.deepEqual(state(n,def),{toggleEnabled:false,contentInteractive:true});}
});
test('preview image alone is not a completed 3D interaction resource',()=>{
 assert.equal(has(node('model3d',{content:'preview.png'})),false);assert.equal(has(node('stage3d',{content:'preview.png'})),false);
});
test('ordinary plugin content and forceInteractive behavior stay unchanged',()=>{
 const n=node('plugin:panorama',{content:'image.jpg',interactive:false});assert.deepEqual(state(n,def),{toggleEnabled:true,contentInteractive:false});assert.deepEqual(state(n,{...def,forceInteractive:()=>true}),{toggleEnabled:false,contentInteractive:true});
});
test('nodes without a toggle are not disabled by an interactive false flag',()=>{
 assert.deepEqual(state(node('image',{content:'image.jpg',interactive:false}),{}),{toggleEnabled:false,contentInteractive:true});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createPromptOptimizer} from '../src/prompt-optimizer.js';
import schema from './fixtures/h3-prompt-object-info.json' with {type:'json'};
const rootDir=path.resolve(import.meta.dirname,'..');
const output='integrated_multimodal_description: A toy car moves.\noverall_soundscape: Room ambience.\nnon_diegetic_music: Quiet instrumental.';
function fixture(info=structuredClone(schema), extra={}) {
 let graph, submits=0, scans=0;
 const optimizer=createPromptOptimizer({config:{rootDir},comfy:{objectInfo:async()=>{scans++;return info},submit:async g=>{graph=g;submits++;return {promptId:'fixture'}},history:async()=>({status:{completed:true},outputs:{'4':{text:[output]}}})},...extra});
 return {optimizer,get graph(){return graph},get submits(){return submits},get scans(){return scans}};
}
test('text H3 uses installed llama nodes without mmproj and retains local template and offload',async()=>{
 const info=structuredClone(schema);info.llama_cpp_model_loader.input.required.mmproj[0]=['None'];const f=fixture(info);
 await f.optimizer.optimize({prompt:'toy car',engine:'local',language:'en'});
 assert.equal(f.graph['1'].class_type,'llama_cpp_model_loader');assert.equal(f.graph['1'].inputs.mmproj,'None');assert.equal(f.graph['1'].inputs.chat_handler,'None');assert.equal(f.graph['3'].class_type,'llama_cpp_instruct_adv');assert.equal(f.graph['3'].inputs.images,undefined);assert.equal(f.graph['3'].inputs.force_offload,true);assert.equal(f.graph['3'].inputs.save_states,false);assert.equal(f.graph['2'].inputs['增强方式'],'本地模板');assert.match(f.graph['3'].inputs.system_prompt,/English/);assert.equal(f.graph['5'].inputs.max_tokens,4096);assert.equal(f.scans,1);
});
test('one image uses matching Qwen3.5 projector and preserves the uploaded name',async()=>{
 const f=fixture();await f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'}]});
 assert.equal(f.graph['1'].inputs.mmproj,'mmproj-BF16.gguf');assert.equal(f.graph['1'].inputs.chat_handler,'Qwen3.5');assert.deepEqual(f.graph['3'].inputs.images,['9101',0]);assert.equal(f.graph['9101'].inputs.image,'a.png');
});
test('multiple images use ordered core list outputs, not a cropped ImageBatch or a nested tensor list',async()=>{
 const f=fixture();await f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'},{name:'b.png'},{name:'c.png',subfolder:'folder'}]});
 assert.equal(f.graph['9200'].class_type,'CreateList');assert.deepEqual(f.graph['9200'].inputs,{'inputs.input0':['9101',0],'inputs.input1':['9102',0],'inputs.input2':['9103',0]});assert.deepEqual(f.graph['3'].inputs.images,['9200',0]);assert.equal(f.graph['9103'].inputs.image,'folder/c.png');assert.ok(!Object.values(f.graph).some(n=>['ImageBatch','ImageTensorList'].includes(n.class_type)));
});
test('missing inference node returns actionable class name before submission',async()=>{
 const info=structuredClone(schema);delete info.llama_cpp_instruct_adv;const f=fixture(info);
 await assert.rejects(f.optimizer.optimize({prompt:'car'}),e=>e.code==='h3_prompt_missing_nodes'&&e.message.includes('llama_cpp_instruct_adv'));assert.equal(f.submits,0);
});
test('missing vision projector rejects without fuzzy pairing Qwen3.8 or dropping images',async()=>{
 const info=structuredClone(schema);info.llama_cpp_model_loader.input.required.mmproj[0]=['None','mmproj-Qwen3.8-27B-BF16.gguf'];let fuzzyCalls=0;
 const f=fixture(info,{modelAliasFor:()=>{fuzzyCalls++;return 'mmproj-Qwen3.8-27B-BF16.gguf'}});
 await assert.rejects(f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'}]}),e=>e.code==='h3_prompt_missing_mmproj'&&e.message.includes('mmproj-BF16.gguf'));assert.equal(f.submits,0);assert.equal(fuzzyCalls,0);
});
test('user alias is explicit, while exact filenames in subfolders resolve without model substitution',async()=>{
 const info=structuredClone(schema);info.llama_cpp_model_loader.input.required.model[0]=['local/Qwen3.5-9B-Q6_K.gguf'];info.llama_cpp_model_loader.input.required.mmproj[0]=['None','vision/mmproj-BF16.gguf'];
 const f=fixture(info,{userModelAliasFor:(_c,k)=>k==='model'?'Qwen3.5-9B-Q6_K.gguf':''});await f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'}]});assert.equal(f.graph['1'].inputs.model,'local/Qwen3.5-9B-Q6_K.gguf');assert.equal(f.graph['1'].inputs.mmproj,'vision/mmproj-BF16.gguf');
});
test('unknown required input and unsupported handler fail preflight',async()=>{
 for(const change of [s=>s.llama_cpp_instruct_adv.input.required.newRequired=['STRING'],s=>s.llama_cpp_model_loader.input.required.chat_handler[0]=['None']]){const info=structuredClone(schema);change(info);const f=fixture(info);await assert.rejects(f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'}]}),e=>e.code==='h3_prompt_node_incompatible');assert.equal(f.submits,0);}
});
test('missing multi-image core node rejects, single-image path does not require it',async()=>{
 const info=structuredClone(schema);delete info.CreateList;const f=fixture(info);await f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'}]});await assert.rejects(f.optimizer.optimize({prompt:'car',uploadedImages:[{name:'a.png'},{name:'b.png'}]}),e=>e.code==='h3_prompt_missing_nodes'&&e.message.includes('CreateList'));assert.equal(f.submits,1);
});
test('empty generation cannot be replaced by intermediate template output',async()=>{
 const optimizer=createPromptOptimizer({config:{rootDir},comfy:{objectInfo:async()=>structuredClone(schema),submit:async()=>({promptId:'empty'}),history:async()=>({status:{completed:true},outputs:{'2':{text:['Intermediate template']},'4':{text:['']}}})}});
 await assert.rejects(optimizer.optimize({prompt:'car'}),e=>e.code==='no_prompt_output');
});
test('cancelled request never scans or submits',async()=>{
 const f=fixture();await assert.rejects(f.optimizer.optimize({prompt:'car',signal:AbortSignal.abort()}),e=>e.code==='cancelled');assert.equal(f.scans,0);assert.equal(f.submits,0);
});

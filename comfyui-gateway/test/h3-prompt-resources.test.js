import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createResourceManager} from '../src/resources.js';

test('Qwen3.8 projector cannot mark Qwen3.5 installed through name/size similarity; explicit replacement still works',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'h3-projector-'));const comfy=path.join(root,'ComfyUI'),data=path.join(root,'data'),resources=path.join(root,'resources');
 await fs.mkdir(path.join(comfy,'models','LLM'),{recursive:true});await fs.mkdir(data);await fs.mkdir(resources);
 await fs.writeFile(path.join(comfy,'models','LLM','mmproj-Qwen3.8-27B-BF16.gguf'),'same-size');
 const index={schema:1,version:'test',packs:[],resources:[{id:'prompt_qwen_mmproj',type:'model',target:'LLM/mmproj-BF16.gguf',size:9}]};await fs.writeFile(path.join(resources,'index.json'),JSON.stringify(index));
 let replacement='';const setup={loaderOptions:()=>({}),status:()=>({comfyReachable:true}),hasNodeClass:()=>true,scan:async()=>({}),userModelAliasFor:()=>replacement,setModelAliases:async entries=>{replacement=entries[0].to}};
 const manager=createResourceManager({config:{rootDir:root,dataDir:data,comfyDir:comfy,comfyWorkflowsDir:'',resourcesIndexUrl:'',resourcesFetchTimeoutMs:1000,resourceConcurrency:1},setup,logger:null});
 try{await manager.init();const before=manager.status().resources[0];assert.equal(before.status,'missing');assert.equal(before.matchedBy,'');await manager.setResourceReplacement('prompt_qwen_mmproj','explicit-matching-pair.gguf');const after=manager.status().resources[0];assert.equal(after.status,'present');assert.equal(after.matchedBy,'alias');assert.equal(after.overridden,true);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLocalOutput } from '../src/local-output.js';
import { createComfyClient } from '../src/comfy-client.js';

test('desktop completed output is read locally with exact bytes and without HTTP view',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-output-'));const original=globalThis.fetch;let calls=0;
 try{await fs.mkdir(path.join(root,'MiniMaxH3'));const bytes=Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]);await fs.writeFile(path.join(root,'MiniMaxH3','clip.mp4'),bytes);
 globalThis.fetch=async()=>{calls++;throw Error('view hangs');};const client=createComfyClient({baseUrl:'http://127.0.0.1:8188',localOutputDir:root,autoDiscover:false,retryAttempts:1});
 const result=await client.view({filename:'clip.mp4',subfolder:'MiniMaxH3',type:'output'});assert.deepEqual(result.buffer,bytes);assert.equal(result.contentType,'video/mp4');assert.equal(calls,0);
 for(const file of [{filename:'../clip.mp4',type:'output'},{filename:'clip.mp4',subfolder:'../',type:'output'},{filename:'C:\\clip.mp4',type:'output'}]) await assert.rejects(client.view(file),{code:'invalid_output_path'});
 assert.equal(calls,0);assert.equal(await readLocalOutput(root,{filename:'clip.mp4',type:'input'}),null);
 }finally{globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});}
});
test('local output rejects links outside trusted root and missing files are explicit',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'output-links-'));const outside=await fs.mkdtemp(path.join(os.tmpdir(),'output-outside-'));
 try{await fs.writeFile(path.join(outside,'x.mp4'),'private');await fs.symlink(outside,path.join(root,'link'),'junction');await assert.rejects(readLocalOutput(root,{filename:'x.mp4',subfolder:'link',type:'output'}),/escapes/);assert.equal(await readLocalOutput(root,{filename:'absent.mp4',type:'output'}),null);}finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
test('remote /view body has a hard deadline even if body reader ignores AbortSignal',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,headers:new Headers({'content-type':'video/mp4'}),arrayBuffer:()=>new Promise(()=>{})});
 try{const client=createComfyClient({baseUrl:'http://127.0.0.1:8188',autoDiscover:false,retryAttempts:1,outputTimeoutMs:20});const start=Date.now();await assert.rejects(client.view({filename:'x.mp4',type:'output'}),{code:'comfy_aborted'});assert.ok(Date.now()-start<1500);}finally{globalThis.fetch=original;}
});
test('HTTP header wait is also bounded and no unfinished result is published',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Promise(()=>{});
 try{const client=createComfyClient({baseUrl:'http://127.0.0.1:8188',autoDiscover:false,retryAttempts:1,outputTimeoutMs:20});await assert.rejects(client.view({filename:'x.mp4',type:'output'}),{code:'comfy_aborted'});}finally{globalThis.fetch=original;}
});

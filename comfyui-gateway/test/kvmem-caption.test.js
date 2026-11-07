import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createGatewayApp, stopGateway } from '../src/server.js';
import { createPromptOptimizer } from '../src/prompt-optimizer.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const image='data:image/png;base64,aGVsbG8=';

test('configured KVMem replaces legacy local caption selectors, never submits Comfy graphs',async()=>{
 const calls=[];
 const optimizer=createPromptOptimizer({config:{rootDir:path.resolve(here,'..')},comfy:{submit:()=>{throw Error('must not submit');}},localCaption:async args=>{calls.push(args);return {prompt:'红色方形',engine:'kvmem',released:true};}});
 for(const engine of ['qwen35','florence','kvmem']){const result=await optimizer.captionImage({engine,localImages:[image]});assert.equal(result.engine,'kvmem');assert.equal(result.released,true);}
 assert.equal(calls.length,3);assert.equal(calls[0].imageDataUrl,image);
 await assert.rejects(optimizer.captionImage({engine:'bogus',localImages:[image]}),{code:'invalid_caption_engine'});
 await assert.rejects(optimizer.captionImage({engine:'kvmem',localImages:[]}),{code:'missing_reference_image'});
 const legacy=createPromptOptimizer({config:{rootDir:path.resolve(here,'..')},comfy:{}});
 await assert.rejects(legacy.captionImage({engine:'kvmem'}),{code:'kvmem_not_configured'});
});

test('HTTP caption uses private image data, holds Comfy admission and closes on gateway shutdown',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'kvmem-gateway-'));
 let upstream,server,gateway;let upload=0,submitted=0,free=0,closed=0;let finish;
 const started=new Promise(resolve=>{finish=resolve;});let release;
 const ready={id:'kvmem',label:'KVMem / NInfer',available:true,enabled:true,reasons:[],missingNodes:[],missingResources:[]};
 const runtime={capability:()=>ready,isBusy:()=>false,caption:async args=>{assert.equal(args.imageDataUrl,image);assert.equal(args.timeoutSeconds,900);finish();await new Promise(r=>{release=r;});return {prompt:'红色方形',engine:'kvmem',released:true};},close:async()=>{closed++;}};
 try{
  upstream=http.createServer((req,res)=>{let data;if(req.url==='/queue')data={queue_running:[],queue_pending:[]};else if(req.url==='/free'){free++;data={};}else if(req.url==='/system_stats')data={devices:[{index:0,type:'cuda',vram_free:16*1024**3,torch_vram_free:0}]};else if(req.url==='/upload/image'){upload++;data={name:'x.png'};}else if(req.url==='/prompt'){submitted++;data={prompt_id:'p'};}else data={};res.setHeader('content-type','application/json');res.end(JSON.stringify(data));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  gateway=await createGatewayApp({desktopDistribution:true,kvmem:{enabled:true,modelPath:fileURLToPath(import.meta.url),gpuDevice:'0',startupTimeoutMs:180000,requestTimeoutMs:180000},kvmemRuntime:runtime,comfyUrl:`http://127.0.0.1:${upstream.address().port}`,dataDir:path.join(root,'data'),outputDir:path.join(root,'out'),workflowDir:path.join(root,'workflows'),scanOnStart:false,watchWorkflows:false,resourcesIndexUrl:'http://127.0.0.1:1/no',resourcesIndexUrlBackup:'',resourcesFetchTimeoutMs:10});
  server=http.createServer(gateway.app);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const form=new FormData();form.set('engine','qwen35');form.set('localTimeoutSeconds','900');form.append('image',new Blob([Buffer.from('hello')],{type:'image/png'}),'image.png');
  const response=fetch(url+'/v1/prompts/caption',{method:'POST',body:form});await started;
  await assert.rejects(gateway.comfy.submit({}),{code:'local_gpu_busy'});assert.equal(submitted,0);assert.equal(upload,0);assert.equal(free,1);
  release();const r=await response;assert.equal(r.status,200);assert.equal((await r.json()).released,true);
  await gateway.comfy.submit({});assert.equal(submitted,1);
  const status=await fetch(url+'/api/resources/status').then(r=>r.json());assert.equal(status.promptCapabilities.captionBackend,'kvmem');assert.equal(status.promptCapabilities.engines.kvmem.available,true);assert.equal(status.promptCapabilities.captionStartupTimeoutMs,180000);
  for(const endpoint of ['optimize','optimize-image','caption']){
   const bad=new FormData();bad.set('engine','local');bad.set('prompt','fixture');bad.set('mode',endpoint==='optimize'?'文生视频(T2VA)':'text');bad.set('localTimeoutSeconds','29');if(endpoint==='caption'){bad.set('engine','kvmem');bad.append('image',new Blob([Buffer.from('hello')],{type:'image/png'}),'image.png');}
   const response=await fetch(url+'/v1/prompts/'+endpoint,{method:'POST',body:bad});assert.equal(response.status,400,endpoint);assert.equal((await response.json()).error.code,'local_invalid_timeout');
  }
  assert.equal(submitted,1);assert.equal(upload,0);
  const invalid=new FormData();invalid.set('engine','kvmem');invalid.append('image',new Blob(['bad'],{type:'text/plain'}),'bad.txt');assert.equal((await fetch(url+'/v1/prompts/caption',{method:'POST',body:invalid})).status,400);
 }finally{release?.();if(gateway)await stopGateway({...gateway,server});if(server)server.closeAllConnections?.();if(upstream)await new Promise(r=>upstream.close(r));await fs.rm(root,{recursive:true,force:true});}
 assert.equal(closed,1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {before,after,test} from 'node:test';
import {createMockComfyServer} from '../mock/comfyui-mock.mjs';
import {createGatewayApp,stopGateway} from '../src/server.js';
process.env.DISABLE_NODE_BOOTSTRAP='1';process.env.ASSISTANT_ENABLED='0';
let root,mock,gateway,server,url;
before(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'h3-reference-mode-'));const workflows=path.join(root,'workflows');await fs.mkdir(workflows);
 await fs.copyFile(new URL('./fixtures/mock-video.json',import.meta.url),path.join(workflows,'mock-video.json'));
 const ids=['video-h3-ref2va','video-h3-ref2va-novdn','video-h3-t2v','video-h3-t2v-novdn','video-h3-frames','video-h3-frames-novdn','video-h3-fast'];
 await fs.writeFile(path.join(workflows,'registry.json'),JSON.stringify({version:1,workflows:ids.map(id=>({id,name:id,type:'video',file:'mock-video.json',minMedia:id.includes('ref2va')?1:0,bindings:{prompt:{node:'6',input:'text'}}}))}));
 mock=createMockComfyServer({port:0,delayMs:20,quiet:true});await mock.start();
 gateway=await createGatewayApp({comfyUrl:mock.url,workflowDir:workflows,dataDir:path.join(root,'data'),outputDir:path.join(root,'output'),scanOnStart:false,watchWorkflows:false,updateEnabled:false,resourcesIndexUrl:'',resourcesIndexUrlBackup:'',desktopDistribution:true,requestTimeoutMs:10000,videoTimeoutMs:10000,pollIntervalMs:20});
 // GPU/runtime availability is not part of this protocol-only fixture.
 gateway.setup.setRuntimeProblemProvider(()=>[]);
 await gateway.setup.scan();server=gateway.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url=`http://127.0.0.1:${server.address().port}`;
 // We test HTTP validation, upload and persisted request contracts, not diffusion.
 gateway.tasks.enqueue=()=>{};
});
after(async()=>{if(gateway)await stopGateway({...gateway,server});await mock?.stop();if(root)await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
async function send(model,mode,media=[],params={}){
 const body=new FormData();body.set('model',model);body.set('mode',mode);body.set('prompt','Neutral fixture');body.set('seconds','4');body.set('size','448x256');body.set('params',JSON.stringify(params));
 for(const [type,index=0]of media){const data=type==='image'?await fs.readFile(new URL('../mock/assets/mock.png',import.meta.url)):type==='video'?await fs.readFile(new URL('../mock/assets/mock.mp4',import.meta.url)):Buffer.from('RIFFfixture-audio');const field=type==='image'?'image[]':type==='audio'?'audio[]':'video[]';body.append(field,new Blob([data],{type:type==='image'?'image/png':type==='audio'?'audio/wav':'video/mp4'}),`${type}${index}.${type==='image'?'png':type==='audio'?'wav':'mp4'}`);if(type==='video')body.set('source_duration_seconds','1');}
 const response=await fetch(url+'/v1/videos',{method:'POST',body});return {status:response.status,data:await response.json()};
}
test('VDN and noVDN ref2va accept each supplied media kind even with stale text mode',async()=>{
 for(const id of ['video-h3-ref2va','video-h3-ref2va-novdn'])for(const type of ['image','audio','video']){const r=await send(id,'text',[[type]]);assert.equal(r.status,200,JSON.stringify(r.data));const t=gateway.tasks.get(r.data.id);assert.equal(t.model,id);assert.equal(t.request.mode,'reference');assert.equal(t.request[type==='image'?'images':type==='video'?'videos':'audios'].length,1);}
});
test('mixed ref2va input retains all media categories',async()=>{
 const r=await send('video-h3-ref2va-novdn','frames',[['image'],['audio'],['video']]);assert.equal(r.status,200);const req=gateway.tasks.get(r.data.id).request;assert.equal(req.mode,'reference');for(const k of ['images','videos','audios'])assert.equal(req[k].length,1);
});
test('genuinely empty references still produce missing_reference_media',async()=>{
 for(const id of ['video-h3-ref2va','video-h3-ref2va-novdn']){const r=await send(id,'text');assert.equal(r.status,400);assert.equal(r.data.error.code,'missing_reference_media');}
});
test('noVDN text validation rejects attached media like its VDN sibling',async()=>{
 for(const id of ['video-h3-t2v','video-h3-t2v-novdn']){const r=await send(id,'reference',[['image']]);assert.equal(r.status,400);assert.equal(r.data.error.code,'unsupported_video_media');const clean=await send(id,'frames');assert.equal(clean.status,200);assert.equal(gateway.tasks.get(clean.data.id).request.mode,'text');}
});
test('noVDN frames validate media type count and explicit frame selection',async()=>{
 for(const id of ['video-h3-frames','video-h3-frames-novdn']){
  const audio=await send(id,'reference',[['audio']]);assert.equal(audio.status,400);assert.equal(audio.data.error.code,'unsupported_video_media');
  const missing=await send(id,'text',[['image']],{frameMode:'both'});assert.equal(missing.status,400);assert.equal(missing.data.error.code,'missing_reference_image');
  const last=await send(id,'text',[['image']],{frameMode:'last'});assert.equal(last.status,200);assert.equal(gateway.tasks.get(last.data.id).request.mode,'frames');
 }
});
test('fast draft keeps configurable text mode rather than becoming reference',async()=>{
 const r=await send('video-h3-fast','text');assert.equal(r.status,200);assert.equal(gateway.tasks.get(r.data.id).request.mode,'text');
 const invalid=await send('video-h3-fast','text',[['image']]);assert.equal(invalid.status,400);assert.equal(invalid.data.error.code,'unsupported_video_media');
});

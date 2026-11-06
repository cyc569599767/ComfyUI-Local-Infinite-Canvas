import {afterAll,expect,test} from 'bun:test';
import type {AiConfig,ChannelModel} from '../src/stores/use-config-store';
import type {CanvasNodeData} from '../src/types/canvas';
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');const storage=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
const {defaultConfig}=await import('../src/stores/use-config-store');
const {buildGenerationConfig}=await import('../src/lib/canvas/canvas-generation-helpers');
const {resolveVideoWorkflowMode}=await import('../src/lib/canvas/video-model-mode');
const {createVideoGenerationTask}=await import('../src/services/api/video');
const {buildNodeGenerationContext}=await import('../src/components/canvas/canvas-node-generation');
const requests:FormData[]=[];
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{requests.push(await req.formData());return Response.json({id:'fixture-task',status:'queued'});}});
afterAll(()=>{server.stop(true);if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage');});
const workflowIds=['video-h3-ref2va','video-h3-ref2va-novdn','video-h3-frames','video-h3-frames-novdn','video-h3-t2v','video-h3-t2v-novdn','video-h3-fast','video-h3-character-swap'];
const models:ChannelModel[]=workflowIds.map(id=>({name:id,workflowId:id,capability:'video'}));models.push({name:'custom-base',workflowId:'video-h3-ref2va-novdn',baseModel:'custom.safetensors',capability:'video'},{name:'other-provider',capability:'video'});
const config:AiConfig={...defaultConfig,videoMode:'text',size:'448x256',vquality:'448',videoSeconds:'4',referenceAcceleration:false,channels:[{id:'fixture',name:'Fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,apiKey:'test',apiFormat:'openai',models}]};
const pic={id:'ref',name:'ref.png',type:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII='};
const vid={id:'v',name:'video.mp4',type:'video/mp4',url:'data:video/mp4;base64,AAAAHGZ0eXBpc29t',durationMs:1000};
const aud={id:'a',name:'audio.wav',type:'audio/wav',url:'data:audio/wav;base64,UklGRiQAAABXQVZF'};
const selected=(name:string)=>({...config,model:`fixture::${name}`,videoModel:`fixture::${name}`});
test('fixed H3 modes override stale node settings for VDN and no-VDN, not fast or external models',()=>{
 for(const id of workflowIds){const expected=id.includes('ref2va')||id.includes('character-swap')?'reference':id.includes('t2v')?'text':id.includes('frames')?'frames':'text';expect(resolveVideoWorkflowMode(config,`fixture::${id}`,'text')).toBe(expected);}
 for(const mode of ['text','frames','reference'])for(const id of ['video-h3-fast','other-provider'])expect(resolveVideoWorkflowMode(config,`fixture::${id}`,mode)).toBe(mode);
 expect(resolveVideoWorkflowMode(config,'fixture::custom-base','text')).toBe('reference');
});
test('actual graph shape keeps reference image and repairs only effective generation mode',async()=>{
 const source:CanvasNodeData={id:'ref',type:'image',title:'Ref',position:{x:0,y:0},width:100,height:100,metadata:{content:pic.dataUrl,status:'success'}};
 const video:CanvasNodeData={id:'video',type:'video',title:'Video',position:{x:300,y:0},width:100,height:100,metadata:{model:'fixture::video-h3-ref2va-novdn',videoMode:'text',status:'error'}};
 const nodes=[source,video],edges=[{id:'ref-link',fromNodeId:'ref',toNodeId:'video'}];const before=JSON.stringify({nodes,edges});
 const context=buildNodeGenerationContext('video',nodes,edges,'Test prompt');const effective=buildGenerationConfig(config,video,'video');expect(effective.videoMode).toBe('reference');expect(context.referenceImages).toHaveLength(1);
 await createVideoGenerationTask(effective,context.prompt,context.referenceImages);const body=requests.at(-1)!;expect(body.get('mode')).toBe('reference');expect(body.getAll('images')).toHaveLength(1);expect(body.get('model')).toBe('video-h3-ref2va-novdn');expect(JSON.stringify({nodes,edges})).toBe(before);
});
test('request boundary also repairs stale text and sends images for default and base-model variants',async()=>{
 for(const name of ['video-h3-ref2va','video-h3-ref2va-novdn','custom-base']){const c=selected(name);await createVideoGenerationTask(c,'Prompt',[pic]);const body=requests.at(-1)!;expect(body.get('mode')).toBe('reference');expect(body.getAll('image[]')).toHaveLength(1);expect(body.get('model')).toBe(name);expect(c.videoMode).toBe('text');}
});
test('audio-only and video-only reference requests are not dropped by stale text/frames mode',async()=>{
 for(const mode of ['text','frames']){
  await createVideoGenerationTask({...selected('video-h3-ref2va-novdn'),videoMode:mode},'Prompt',[],{audios:[aud]});let body=requests.at(-1)!;expect(body.getAll('audio[]')).toHaveLength(1);expect(body.get('mode')).toBe('reference');
  await createVideoGenerationTask({...selected('video-h3-ref2va-novdn'),videoMode:mode},'Prompt',[],{videos:[vid]});body=requests.at(-1)!;expect(body.getAll('video[]')).toHaveLength(1);expect(body.get('source_duration_seconds')).toBe('1');
 }
});
test('mixed references retain workflow media limits and correct model identity',async()=>{
 await createVideoGenerationTask(selected('video-h3-ref2va-novdn'),'Prompt',Array.from({length:8},(_,i)=>({...pic,id:String(i)})),{videos:[vid,vid],audios:[aud,aud,aud]});const body=requests.at(-1)!;expect(body.getAll('images')).toHaveLength(6);expect(body.getAll('video[]')).toHaveLength(1);expect(body.getAll('audio[]')).toHaveLength(2);
});
test('fast draft configured text remains text and uploads no attached images',async()=>{
 await createVideoGenerationTask(selected('video-h3-fast'),'Prompt',[pic]);const body=requests.at(-1)!;expect(body.get('mode')).toBe('text');expect(body.getAll('images')).toHaveLength(0);
});
test('fixed text workflow cannot inherit stale reference mode',async()=>{
 await createVideoGenerationTask({...selected('video-h3-t2v-novdn'),videoMode:'reference'},'Prompt',[pic],{videos:[vid],audios:[aud]});const body=requests.at(-1)!;expect(body.get('mode')).toBe('text');expect(body.getAll('images')).toHaveLength(0);expect(body.getAll('video[]')).toHaveLength(0);expect(body.getAll('audio[]')).toHaveLength(0);
});
test('no-reference request does not manufacture media to bypass server validation',async()=>{
 await createVideoGenerationTask(selected('video-h3-ref2va-novdn'),'Prompt',[]);const body=requests.at(-1)!;expect(body.get('mode')).toBe('reference');expect(body.getAll('images')).toHaveLength(0);expect(body.getAll('video[]')).toHaveLength(0);expect(body.getAll('audio[]')).toHaveLength(0);
});

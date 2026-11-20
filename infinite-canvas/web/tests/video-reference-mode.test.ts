import {afterAll,expect,test} from 'bun:test';
import type {AiConfig,ChannelModel} from '../src/stores/use-config-store';
import type {CanvasNodeData} from '../src/types/canvas';
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');const storage=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
const {defaultConfig}=await import('../src/stores/use-config-store');
const {buildGenerationConfig}=await import('../src/lib/canvas/canvas-generation-helpers');
const {resolveVideoWorkflowMode}=await import('../src/lib/canvas/video-model-mode');
const {createVideoGenerationTask,createVideoUpscaleTask}=await import('../src/services/api/video');
const {buildNodeGenerationContext}=await import('../src/components/canvas/canvas-node-generation');
const {requestLocalAudioGeneration}=await import('../src/services/api/audio');
const requests:FormData[]=[];
const requestPaths:string[]=[];
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{requestPaths.push(new URL(req.url).pathname);requests.push(await req.formData());return Response.json(new URL(req.url).pathname.endsWith('/audio/speech')?{data:[{b64_json:'AA=='}],mime_type:'audio/wav'}:{id:'fixture-task',status:'queued'});}});
afterAll(()=>{server.stop(true);if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage');});
const workflowIds=['video-h3-ref2va','video-h3-ref2va-novdn','video-h3-frames','video-h3-frames-novdn','video-h3-t2v','video-h3-t2v-novdn','video-h3-fast','video-h3-character-swap'];
const models:ChannelModel[]=workflowIds.map(id=>({name:id,workflowId:id,capability:'video'}));models.push({name:'custom-base',workflowId:'video-h3-ref2va-novdn',baseModel:'custom.safetensors',capability:'video'},{name:'other-provider',capability:'video'});
const config:AiConfig={...defaultConfig,videoMode:'text',size:'448x256',vquality:'448',videoSeconds:'4',referenceAcceleration:false,channels:[{id:'fixture',name:'Fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,apiKey:'test',apiFormat:'openai',models}]};
const pic={id:'ref',name:'ref.png',type:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII='};
const vid={id:'v',name:'video.mp4',type:'video/mp4',url:'data:video/mp4;base64,AAAAHGZ0eXBpc29t',durationMs:1000};
const aud={id:'a',name:'audio.wav',type:'audio/wav',url:'data:audio/wav;base64,UklGRiQAAABXQVZF'};
const selected=(name:string)=>({...config,model:`fixture::${name}`,videoModel:`fixture::${name}`});
test('SeedVR2 method preserves its dedicated endpoint, source video and selected scale',async()=>{
 for(const scale of [1.5,2]){
  const resolution=Math.round(720*scale),before=requests.length;
  const task=await createVideoUpscaleTask(selected('video-h3-ref2va'),{name:'source.mp4',type:'video/mp4',url:vid.url},{scale,resolution,fps:24});
  expect(requests.length).toBe(before+1);expect(requestPaths.at(-1)).toBe('/v1/videos/upscale');
  const body=requests.at(-1)!;const source=body.get('video');expect(source).toBeInstanceOf(File);expect((source as File).name).toBe('source.mp4');expect((source as File).type).toBe('video/mp4');
  expect(JSON.parse(String(body.get('params')))).toEqual({scale,resolution,fps:24,batch_size:5,color_correction:'wavelet'});
  expect(task).toEqual({id:'fixture-task',provider:'openai',model:'video-seedvr2-upscale'});
 }
});

test('RelayVSR method targets its own workflow and sends only its own params',async()=>{
 const before=requests.length;
 const task=await createVideoUpscaleTask(selected('video-h3-ref2va'),{name:'source.mp4',type:'video/mp4',url:vid.url},{scale:2,resolution:2880,fps:24,seed:7,factor:4,detail:0.5},{method:'relayvsr'});
 expect(requests.length).toBe(before+1);expect(requestPaths.at(-1)).toBe('/v1/videos/upscale');
 const body=requests.at(-1)!;
 expect(body.get('model')).toBe('video-relayvsr-upscale');
 expect(task).toEqual({id:'fixture-task',provider:'openai',model:'video-relayvsr-upscale'});
 const params=JSON.parse(String(body.get('params')));
 expect(params).toEqual({scale:2,resolution:2880,fps:24,seed:7,factor:4,detail:0.5});
 // SeedVR2 专属字段不能一起发过去，否则后端会拿默认值覆盖权重档位。
 expect(params.batch_size).toBeUndefined();expect(params.color_correction).toBeUndefined();
});

test('DLSS5 method targets its own workflow and sends only its own params',async()=>{
 const before=requests.length;
 const task=await createVideoUpscaleTask(selected('video-h3-ref2va'),{name:'source.mp4',type:'video/mp4',url:vid.url},{scale:1.5,resolution:1024,fps:24,factor:2,detail:0.5,color:0.25,style:'default',motion:'auto'},{method:'dlss5'});
 expect(requests.length).toBe(before+1);expect(requestPaths.at(-1)).toBe('/v1/videos/upscale');
 const body=requests.at(-1)!;
 expect(body.get('model')).toBe('video-dlss5-upscale');
 expect(task).toEqual({id:'fixture-task',provider:'openai',model:'video-dlss5-upscale'});
 const params=JSON.parse(String(body.get('params')));
 expect(params).toEqual({scale:1.5,resolution:1024,fps:24,factor:2,detail:0.5,color:0.25,style:'default',motion:'auto'});
 // DLSS5 没有 batch/color_correction，也不发 SeedVR2 的种子语义字段。
 expect(params.batch_size).toBeUndefined();expect(params.color_correction).toBeUndefined();
});

test('upscale method defaults to SeedVR2 so old call sites keep the previous model',async()=>{
 await createVideoUpscaleTask(selected('video-h3-ref2va'),{name:'source.mp4',type:'video/mp4',url:vid.url},{scale:1.5,resolution:1080,fps:24});
 const body=requests.at(-1)!;
 expect(body.get('model')).toBe('video-seedvr2-upscale');
 const params=JSON.parse(String(body.get('params')));
 expect(params).toEqual({scale:1.5,resolution:1080,fps:24,batch_size:5,color_correction:'wavelet'});
 expect(params.factor).toBeUndefined();expect(params.detail).toBeUndefined();
});

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
test('创作专用生成配置不继承云端通道/插帧/全局种子',()=>{
 const node:CanvasNodeData={id:'c',type:'video',title:'c',position:{x:0,y:0},width:300,height:200,metadata:{model:'local-gateway::creation-video-h3-768',creationOutput:{projectNodeId:'wb',stage:'pipeline'},params:{resolution:'540P',aspect_ratio:'9:16',seed:7}}};
 const result=buildGenerationConfig({...config,videoInterpolation:'2x',seed:'999',seedFixed:'true',params:{loras:[{name:'wrong'}]}},node,'video');
 expect(result.channels).toHaveLength(1);expect(result.channels[0].id).toBe('local-gateway');expect(result.channels[0].baseUrl).not.toBe(config.channels[0].baseUrl);
 expect(result.params).toEqual({resolution:'540P',aspect_ratio:'9:16',seed:7,assetName:'c'});expect(result.videoInterpolation).toBe('off');expect(result.videoMode).toBe('reference');
});
test('创作H3九图三音三视频不重复上传且保留分辨率参数',async()=>{
 for(const resolution of ['360p','480p','540p','720p','768p','1080p']) {
  const model=resolution==='1080p'?'creation-video-h3-1080':'creation-video-h3-768';
  await createVideoGenerationTask({...selected(model),videoMode:'text',videoInterpolation:'2x',params:{resolution:resolution.toUpperCase(),aspect_ratio:'9:16'}},'Prompt',Array.from({length:9},(_,i)=>({...pic,id:String(i)})),{videos:[vid,vid,vid],audios:[aud,aud,aud]});
  const body=requests.at(-1)!;
  expect(body.getAll('images')).toHaveLength(9);expect(body.getAll('image[]')).toHaveLength(0);
  expect(body.getAll('videos')).toHaveLength(3);expect(body.getAll('audios')).toHaveLength(3);
  expect(JSON.parse(String(body.get('params')))).toMatchObject({resolution:resolution.toUpperCase(),aspect_ratio:'9:16'});
  expect(JSON.parse(String(body.get('params'))).interpolation).toBeUndefined();
  expect(body.get('model')).toBe(model);expect(body.get('mode')).toBe('reference');expect(body.get('generate_audio')).toBe('true');
 }
 await expect(createVideoGenerationTask({...selected('creation-video-h3-768'),videoMode:'reference'},'Prompt',Array.from({length:10},()=>pic))).rejects.toThrow('最多');
});
test('创作音色音乐和视频请求携带语义名称不把名称混入提示词',async()=>{
 for(const [model,mode,name] of [['creation-audio-voice-design','voice-design','陆明-音色'],['creation-audio-music','music','灯塔主题配乐']] as const){
  await requestLocalAudioGeneration({...selected(model),params:{assetName:name}},mode,{prompt:'实际朗读文案或音乐描述',voiceDescription:'低沉男声'});
  const body=requests.at(-1)!;expect(body.get('input')).toBe('实际朗读文案或音乐描述');expect(JSON.parse(String(body.get('params'))).assetName).toBe(name);
 }
 await createVideoGenerationTask({...selected('creation-video-h3-768'),params:{assetName:'灯塔重逢-视频'}},'镜头运动描述',[pic]);
 expect(JSON.parse(String(requests.at(-1)!.get('params'))).assetName).toBe('灯塔重逢-视频');
});

test('no-reference request does not manufacture media to bypass server validation',async()=>{
 await createVideoGenerationTask(selected('video-h3-ref2va-novdn'),'Prompt',[]);const body=requests.at(-1)!;expect(body.get('mode')).toBe('reference');expect(body.getAll('images')).toHaveLength(0);expect(body.getAll('video[]')).toHaveLength(0);expect(body.getAll('audio[]')).toHaveLength(0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { applyBindings, buildContext } from '../src/bindings.js';
import { runVideo } from '../src/runner.js';
const registry = JSON.parse(fs.readFileSync(new URL('../workflows/registry.json', import.meta.url)));
const entry = registry.workflows.find(row => row.id === 'video-h3-fast');
const workflow = JSON.parse(fs.readFileSync(new URL('../workflows/h3-fast-draft.json', import.meta.url)));
test('draft is a low-resolution four-step FL2VA video graph, not T2VA-only or still-image output', () => {
  assert.equal(workflow['6'].class_type,'MiniMaxH3ImageToVideo');
  assert.equal(workflow['15'].inputs.steps,4);
  assert.match(workflow['2'].inputs.lora_name,/fl2v_turbo_4step/);
  assert.equal(workflow['3'].class_type,'ClipProjLoader');
  assert.equal(workflow['3'].inputs.mode,'streaming');
  assert.equal(workflow['12'].inputs.format,'video/h264-mp4');
  assert.deepEqual(workflow['12'].inputs.images,['11',0]);
  assert.deepEqual(workflow['11'].inputs.samples,['10',0]);
  assert.equal(Object.values(workflow).some(node=>/SaveImage|StillDecode/.test(node.class_type)),false);
});
test('draft binds text and duration to 17k+5 frames, preserving source graph', () => {
  const out=applyBindings(workflow,entry,buildContext({prompt:'Neutral toy car motion',size:'448x256',seconds:4,mode:'text',params:{seed:37}}));
  assert.equal(out['6'].inputs.prompt,'Neutral toy car motion');
  assert.equal(out['6'].inputs.length,107);
  assert.equal(out['6'].inputs.width,448); assert.equal(out['6'].inputs.height,256);
  assert.equal(out['9'].inputs.noise_seed,37); assert.equal(out['12'].inputs.frame_rate,24);
  assert.equal(out['6'].inputs.first_frame,undefined);assert.equal(workflow['6'].inputs.length,124);
});
test('first, last and both image inputs are actual linked video conditioning', () => {
  for(const frameMode of ['first','last','both']) {
    const images=frameMode==='both'?[{name:'first.png'},{name:'last.png'}]:[{name:'one.png'}];
    const out=applyBindings(workflow,entry,buildContext({mode:'frames',uploadedImages:images,params:{frameMode}}));
    const input=out['6'].inputs;
    for(const name of ['first','last']) {
      if(frameMode===name||frameMode==='both') {const link=input[`${name}_frame`];assert.ok(link);assert.equal(out[link[0]].class_type,'LoadImage');}
      else assert.equal(input[`${name}_frame`],undefined);
    }
  }
  assert.throws(()=>applyBindings(workflow,entry,buildContext({mode:'frames',params:{frameMode:'both'},uploadedImages:[{name:'one.png'}]})),/2/);
});
function fakeComfy(files) {
 return {submit:async()=>({promptId:'video-test'}),history:async()=>({status:{completed:true},outputs:{12:{gifs:files.map(({buffer,mimeType,...item})=>item)}}}),view:async f=>{const item=files.find(x=>x.filename===f.filename);return {buffer:item.buffer,contentType:item.mimeType}}};
}
const run = files => runVideo({entry:{...entry,workflow},context:buildContext({mode:'text',seconds:4}),comfy:fakeComfy(files)});
test('VHS PNG preview is ignored and actual MP4 is selected', async()=>{
 const result=await run([{filename:'preview.png',type:'output',mimeType:'image/png',buffer:Buffer.from('PNG')},{filename:'clip.mp4',type:'output',mimeType:'video/mp4',buffer:Buffer.from('0000ftypisom')}]);
 assert.equal(result.files[0].filename,'clip.mp4');assert.equal(result.files.length,1);
});
test('image-only or disguised image output cannot complete a video task', async()=>{
 for(const file of [{filename:'preview.png',mimeType:'image/png',buffer:Buffer.from('PNG')},{filename:'fake.mp4',mimeType:'video/mp4',buffer:Buffer.from([0x89,0x50,0x4e,0x47])},{filename:'fake.mp4',mimeType:'video/mp4',buffer:Buffer.from('GIF89a')},{filename:'fake.mp4',mimeType:'image/webp',buffer:Buffer.from('RIFFxxxxWEBP')}])await assert.rejects(run([{...file,type:'output'}]),e=>e.code==='no_video_output');
});

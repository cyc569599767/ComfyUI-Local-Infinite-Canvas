import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { probeVideoInfo } from '../src/video-probe.js';
const input={buffer:Buffer.from('fixture media'),mimetype:'video/mp4'};
test('ffprobe runs hidden with literal arguments and retains metadata',()=>{
 let file;
 const info=probeVideoInfo(input,[],{execute:(bin,args,options)=>{
  assert.equal(bin,'ffprobe');assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
  assert.equal(options.timeout,20000);assert.equal(options.encoding,'utf8');file=args.at(-1);assert.deepEqual(fs.readFileSync(file),input.buffer);
  return JSON.stringify({streams:[{avg_frame_rate:'24000/1001'}],format:{duration:'2.5'}});
 }});
 assert.equal(info.fps,24000/1001);assert.equal(info.duration,2.5);assert.equal(info.frames,60);assert.equal(fs.existsSync(file),false);
});
test('every fallback candidate is hidden and missing/corrupt probes retain zero fallback',()=>{
 const calls=[];let file;
 assert.deepEqual(probeVideoInfo(input,['C:/with spaces/ffprobe.exe'],{execute:(bin,args,opts)=>{calls.push(bin);file=args.at(-1);assert.equal(opts.windowsHide,true);if(calls.length===1)throw Error('missing');return 'invalid JSON';}}),{fps:0,duration:0,frames:0});
 assert.deepEqual(calls,['ffprobe','C:/with spaces/ffprobe.exe']);assert.equal(fs.existsSync(file),false);
});
test('empty media never starts a process',()=>{
 assert.deepEqual(probeVideoInfo({buffer:Buffer.alloc(0)},[],{execute:()=>{throw Error('must not launch');}}),{fps:0,duration:0,frames:0});
});
test('invalid metadata can fall back to the next probe without accepting NaN',()=>{
 let n=0;const info=probeVideoInfo(input,['alternate'],{execute:()=>JSON.stringify(++n===1?{streams:[{avg_frame_rate:'NaN'}],format:{duration:1}}:{streams:[{avg_frame_rate:'24/1'}],format:{duration:1}})});assert.equal(n,2);assert.equal(info.frames,24);
});

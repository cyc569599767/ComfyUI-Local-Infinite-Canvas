import { expect, test } from 'bun:test';
import { readMediaMetadata } from '../src/lib/media-metadata';

function fakeDocument(mode: 'silent'|'loaded'|'error') {
 let media:any;let pauses=0,loads=0,removed=0;
 const old=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>{
 media={videoWidth:640,videoHeight:360,duration:2.5,pause(){pauses++;},load(){loads++;},removeAttribute(){removed++;},set src(_value:string){if(mode==='loaded')queueMicrotask(()=>media.onloadedmetadata?.());if(mode==='error')queueMicrotask(()=>media.onerror?.());}};return media;}}});
 return {get media(){return media;},counts:()=>({pauses,loads,removed}),restore(){if(old)Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document');}};
}
test('a completed video with a silent metadata decoder settles without blocking card completion',async()=>{
 const f=fakeDocument('silent');try{const start=Date.now();const m=await readMediaMetadata('blob:video','video',10);expect(m).toEqual({width:640,height:360,durationMs:2500});expect(Date.now()-start).toBeLessThan(1000);expect(f.media.onloadedmetadata).toBeNull();expect(f.counts()).toEqual({pauses:1,loads:1,removed:1});}finally{f.restore();}
});
test('loaded metadata retains dimensions and releases temporary decoder',async()=>{const f=fakeDocument('loaded');try{expect(await readMediaMetadata('blob:video','video',100)).toEqual({width:640,height:360,durationMs:2500});expect(f.counts().removed).toBe(1);}finally{f.restore();}});
test('decoder error and missing metadata do not turn valid stored bytes into endless loading',async()=>{const f=fakeDocument('error');try{const result=readMediaMetadata('blob:video','video',100);f.media.videoWidth=0;f.media.videoHeight=0;f.media.duration=Infinity;expect(await result).toEqual({width:1280,height:720});}finally{f.restore();}});

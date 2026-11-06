import { afterAll, expect, test } from 'bun:test';
import type { AiConfig, ChannelModel } from '../src/stores/use-config-store';
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const values = new Map<string,string>();
Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
afterAll(()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage');});
const {defaultConfig,modelOptionLabel} = await import('../src/stores/use-config-store');
const {workflowPickerSelection:pick} = await import('../src/lib/workflow-picker-options');
const models:ChannelModel[] = [
 {name:'video-main',workflowId:'video-h3-frames',label:'H3 首尾帧',capability:'video'},
 {name:'video-h3-fast',workflowId:'video-h3-fast',label:'H3 极速草稿',capability:'video'},
 {name:'video-h3-fast/custom',workflowId:'video-h3-fast',baseModel:'custom.safetensors',label:'Custom base',capability:'video'},
 {name:'image-main',workflowId:'image-main',label:'Image',capability:'image'},
];
const config:AiConfig = {...defaultConfig,channels:['local','other'].map(id=>({id,name:id,baseUrl:'http://127.0.0.1:10017/v1',apiKey:'fixture',apiFormat:'openai',models:structuredClone(models)}))};
test('draft default appears as the selected configured workflow with its real label',()=>{
 const s=pick(config,'local::video-h3-fast','video');
 expect(s.selected).toBe('local::video-h3-fast');expect(s.options).toContain(s.selected);
 expect(modelOptionLabel(config,s.selected)).toBe('H3 极速草稿');
 expect(s.options.filter(v=>v===s.selected)).toHaveLength(1);
});
test('normal and empty nodes still hide dedicated draft workflow entries',()=>{
 for(const value of ['local::video-main','']){const s=pick(config,value,'video');expect(s.options).toEqual(['local::video-main','other::video-main']);}
});
test('switching only selected node exposes/hides its draft option with the same catalog',()=>{
 expect(pick(config,'local::video-main','video').options).not.toContain('local::video-h3-fast');
 expect(pick(config,'local::video-h3-fast','video').options).toContain('local::video-h3-fast');
 expect(pick(config,'local::video-main','video').options).not.toContain('local::video-h3-fast');
});
test('base model variants show their owning workflow without changing saved execution model',()=>{
 const value='local::video-h3-fast/custom';const before=JSON.stringify(config);
 const s=pick(config,value,'video');expect(s.selected).toBe('local::video-h3-fast');expect(s.options).toContain(s.selected);
 expect(s.options).not.toContain(value);expect(JSON.stringify(config)).toBe(before);
});
test('one channel draft does not expose another channel draft',()=>{
 const s=pick(config,'other::video-h3-fast','video');expect(s.options).toContain('other::video-h3-fast');expect(s.options).not.toContain('local::video-h3-fast');
});
test('missing draft is not invented or substituted with another channel or model',()=>{
 const absent={...config,channels:config.channels.filter(c=>c.id!=='local')};
 const s=pick(absent,'local::video-h3-fast','video');expect(s.selected).toBe('local::video-h3-fast');expect(s.options).not.toContain(s.selected);expect(s.options).not.toContain('other::video-h3-fast');
});
test('metadata-free older catalogs can display selected draft and hide it for other nodes',()=>{
 const legacy={...config,channels:[{...config.channels[0],models:models.filter(m=>!m.baseModel).map(({workflowId,...m})=>m)}]};
 expect(pick(legacy,'local::video-h3-fast','video').options).toContain('local::video-h3-fast');
 expect(pick(legacy,'local::video-main','video').options).not.toContain('local::video-h3-fast');
});
test('image selection is not polluted with a video draft option',()=>{
 expect(pick(config,'local::image-main','image').options).toEqual(['local::image-main','other::image-main']);
 expect(pick(config,'local::video-h3-fast','image').options).not.toContain('local::video-h3-fast');
});

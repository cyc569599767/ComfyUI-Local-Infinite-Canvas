'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');

// Invoked only by --distribution-smoke with a throwaway Electron profile.
// Exercises shipped sandboxed pages; never submits an image/video/LLM request.
async function verifyWebSync({contents,canvasUrl,gatewayUrl,runtimeRoot,artifactDir,captureTestImage,setModelCatalog}) {
 const expected=fs.readFileSync(path.join(runtimeRoot,'VERSION'),'utf8').trim();
 const capture=async name=>{
  // AntD modals animate after their DOM becomes visible. Wait for paint before
  // capturing so an old compositor surface cannot masquerade as the new dialog.
  await new Promise(resolve=>setTimeout(resolve,450));
  await captureTestImage(contents,path.join(artifactDir,name));
 };
 const run=code=>contents.executeJavaScript(`(async()=>{
  const wait=async(fn,label)=>{const end=Date.now()+12000;while(!fn()){if(Date.now()>end)throw Error(label+' | '+document.body.innerText.slice(-4500));await new Promise(r=>setTimeout(r,40));}return fn();};
  const visible=el=>!!el&&!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
  const button=(label,scope=document)=>[...scope.querySelectorAll('button')].find(b=>visible(b)&&(b.textContent.trim()===label||b.getAttribute('aria-label')===label||b.title===label));
  const readStore=key=>new Promise((ok,no)=>{const o=indexedDB.open('infinite-canvas');o.onerror=()=>no(o.error);o.onsuccess=()=>{const db=o.result;const q=db.transaction('app_state').objectStore('app_state').get(key);q.onerror=()=>{db.close();no(q.error)};q.onsuccess=()=>{db.close();ok(q.result?JSON.parse(q.result):null)}}});
  ${code}
 })()`);
 const api=await run(`const base=${JSON.stringify(gatewayUrl)};
  const q=await fetch(base+'/api/workflows/image-qwen21').then(r=>r.json());
  const a=await fetch(base+'/api/workflows/image-qwen21-angle').then(r=>r.json());
  const s=await fetch(base+'/api/resources/status').then(r=>r.json());
  const health=await fetch(base+'/health').then(r=>r.json());
  const provider=await fetch(base+'/api/agent/provider',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clear:true})});
  const goohai=s.resources.find(r=>r.id==='goohai_tools');
  return {sourceVersion:health.version,modes:q.schema.variantModes,angleModes:a.schema.variantModes,goohai:goohai?.target,providerWriteStatus:provider.status};`);
 assert.equal(api.sourceVersion,expected);assert.deepEqual([...api.modes].sort(),['edit','inpaint','outpaint','remove','t2i']);assert.deepEqual([...api.angleModes].sort(),['character','scene']);assert.equal(api.providerWriteStatus,409);assert.equal(api.goohai,'custom_nodes/Goohaitools-comfyui');
 const resource=path.join(runtimeRoot,'comfyui-gateway/resources/nodes/unpacked/Goohaitools-comfyui');for(const name of ['__init__.py','LICENSE'])assert.ok(fs.existsSync(path.join(resource,name)),name);
 // The packaged smoke Comfy server intentionally has no model installation.
 // Provide only a clearly synthetic catalog to this throwaway renderer while
 // still verifying the actual gateway schemas above; no inference is enabled.
 const descriptors=[{id:'image-qwen21',metadata:{type:'image',workflowId:'image-qwen21',label:'Qwen Image 2.1',variantModes:api.modes,imageInputs:3}},
  {id:'image-qwen21-angle',metadata:{type:'image',workflowId:'image-qwen21-angle',label:'Qwen 多角度',variantModes:api.angleModes,imageInputs:1}},
  {id:'video-h3-fast',metadata:{type:'video',workflowId:'video-h3-fast',label:'H3 极速草稿',imageInputs:2}}];
 setModelCatalog({data:descriptors,setup:{phase:'ready',scanning:false,stale:false,scanId:100,instanceId:'packaged-web-sync-fixture'}});
 try {
 // Use a non-app document to seed deterministic user data without React's
 // debounced autosave overwriting it. These values never leave the test profile.
 // The canvas server falls back to the SPA for /health; use its actual plain
 // config.js response as a same-origin non-app document while seeding storage.
 await contents.loadURL(canvasUrl+'/config.js');
 await run(`const key='infinite-canvas:ai_config_store';const saved=JSON.parse(localStorage.getItem(key)||'{"state":{"config":{}}}');
  const models=[{name:'image-qwen21',label:'Qwen Image 2.1',capability:'image',workflowId:'image-qwen21',variantModes:['t2i','edit','inpaint','remove','outpaint'],variantLabels:{t2i:'文生图',edit:'多图编辑',inpaint:'局部重绘',remove:'元素移除',outpaint:'扩图'},imageInputs:3},{name:'image-qwen21-angle',label:'Qwen 多角度',capability:'image',workflowId:'image-qwen21-angle',variantModes:['scene','character'],imageInputs:1},{name:'video-h3-fast',label:'H3 极速草稿',capability:'video',workflowId:'video-h3-fast',imageInputs:2}];
  saved.state.config={...saved.state.config,channelMode:'local',imageModel:'local-gateway::image-qwen21',videoModel:'local-gateway::video-h3-fast',model:'local-gateway::image-qwen21',imageMode:'t2i',channels:[{id:'local-gateway',name:'Local',baseUrl:${JSON.stringify(gatewayUrl+'/v1')},apiKey:'local',apiFormat:'openai',models}],models:models.map(m=>'local-gateway::'+m.name),promptCloudApis:[]};localStorage.setItem(key,JSON.stringify(saved));
  localStorage.setItem('canvas-image-quick-tools-v12',JSON.stringify({ids:['info','delete','saveStyle','angle','view'],showLabels:true}));
  const c=document.createElement('canvas');c.width=320;c.height=200;const ctx=c.getContext('2d');ctx.fillStyle='#398ba8';ctx.fillRect(0,0,320,200);ctx.fillStyle='#e8bb65';ctx.fillRect(60,60,90,90);const image=c.toDataURL();
  const project={id:'desktop-web-sync',title:'Desktop Web v0.24.13 acceptance',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),backgroundMode:'lines',showImageInfo:false,viewport:{x:0,y:0,k:0.8},chatSessions:[],activeChatId:null,nodes:[{id:'qwen-image',type:'image',title:'Qwen sync test',position:{x:240,y:180},width:320,height:200,metadata:{content:image,status:'success',mimeType:'image/png',naturalWidth:320,naturalHeight:200,model:'local-gateway::image-qwen21',imageMode:'t2i'}},{id:'draft',type:'video',title:'极速草稿',position:{x:700,y:180},width:260,height:150,metadata:{status:'idle',model:'local-gateway::video-h3-fast',videoMode:'text'}}],connections:[]};
  const recipe={id:'missing-recipe',name:'Missing model guard',thumbAssetId:'',createdAt:new Date().toISOString(),loras:[],config:{model:'removed-provider::missing-image',modelLabel:'Do not substitute'}};
  const db=await new Promise((ok,no)=>{const o=indexedDB.open('infinite-canvas');o.onsuccess=()=>ok(o.result);o.onerror=()=>no(o.error)});const tx=db.transaction('app_state','readwrite'),st=tx.objectStore('app_state');st.put(JSON.stringify({state:{projects:[project],deletedProjects:[]},version:0}),'infinite-canvas:canvas_store');st.put(JSON.stringify({state:{recipes:[recipe]},version:0}),'infinite-canvas:style_recipe_store');await new Promise((ok,no)=>{tx.oncomplete=ok;tx.onerror=()=>no(tx.error)});db.close();`);
 await contents.loadURL(canvasUrl+'/canvas/desktop-web-sync');
 await run(`const node=await wait(()=>document.querySelector('[data-node-id="qwen-image"]'),'Qwen fixture card missing');
  const card=node.querySelector('[data-node-card]')||node;
  card.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:500,clientY:220}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:500,clientY:220}));
  const settings=await wait(()=>button('文生图',node)||button('文生图'),'Qwen settings missing');settings.click();await wait(()=>document.querySelector('.canvas-image-settings-popover'),'Qwen popover missing');
  const panel=document.querySelector('.canvas-image-settings-popover');for(const label of ['文生图','多图编辑','局部重绘','扩图','元素移除'])if(!button(label,panel))throw Error('Missing mode '+label);
  button('元素移除',panel).click();await wait(()=>[...document.querySelectorAll('.ant-modal')].some(m=>visible(m)&&m.textContent.includes('局部遮罩编辑')),'Remove mode did not open mask editor');`);
 await capture('web-sync-qwen-remove.png');
 await run(`const modal=[...document.querySelectorAll('.ant-modal')].find(visible);modal.querySelector('.ant-modal-close').click();
  const angle=await wait(()=>button('生成角度'),'Angle action missing');angle.click();
  await wait(()=>[...document.querySelectorAll('.ant-modal')].some(m=>visible(m)&&m.textContent.includes('视角范围')),'Angle scope dialog missing');
  const dialog=[...document.querySelectorAll('.ant-modal')].find(m=>visible(m)&&m.textContent.includes('视角范围'));
  if(!dialog.textContent.includes('场景人物同转')||!dialog.textContent.includes('只转人物'))throw Error('Angle scopes missing');`);
 await capture('web-sync-angle-scope.png');
 await run(`const dialog=[...document.querySelectorAll('.ant-modal')].find(visible);dialog.querySelector('.ant-modal-close').click();
  button('保存为风格配方').click();
  await wait(()=>button('保存配方'),'Save style dialog missing');
  const saveDialog=[...document.querySelectorAll('.ant-modal')].find(m=>visible(m)&&m.textContent.includes('配方名称'));
  if(!saveDialog?.textContent.includes('Qwen Image 2.1'))throw Error('Style model label mismatch');button('保存配方').click();
  button('风格配方').click();await wait(()=>button('应用'),'Saved style not listed');`);
 const storageDebug=await run(`const result=[];for(const info of await indexedDB.databases()){const db=await new Promise((ok,no)=>{const o=indexedDB.open(info.name);o.onsuccess=()=>ok(o.result);o.onerror=()=>no(o.error)});for(const name of db.objectStoreNames){const value=await new Promise(ok=>{const q=db.transaction(name).objectStore(name).get('infinite-canvas:style_recipe_store');q.onsuccess=()=>ok(q.result);q.onerror=()=>ok(null)});if(value)result.push({db:info.name,store:name,value})}db.close()}return result;`);
 assert.equal(storageDebug.length,1);const storedRecipes=JSON.parse(storageDebug[0].value).state.recipes;assert.equal(storedRecipes[0].config.model,'local-gateway::image-qwen21');
 await run(`const tile=await wait(()=>[...document.querySelectorAll('div.group.relative')].find(el=>el.textContent.includes('Missing model guard')),'Missing recipe tile');
  const apply=button('应用',tile);if(!apply)throw Error('Missing recipe apply control');apply.click();
  await wait(()=>[...document.querySelectorAll('.ant-modal')].some(m=>visible(m)&&m.textContent.includes('缺失的底模')),'Missing style model was silently replaced');
  const missing=[...document.querySelectorAll('.ant-modal')].find(m=>visible(m)&&m.textContent.includes('缺失的底模'));
  if(!missing.textContent.includes('removed-provider::missing-image'))throw Error('Missing style identity not preserved');
  missing.querySelector('.ant-modal-close').click();
  const draft=await wait(()=>document.querySelector('[data-node-id="draft"]'),'Draft card missing');(draft.querySelector('[data-node-card]')||draft).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:900,clientY:220}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:900,clientY:220}));
  await wait(()=>draft.querySelector('[role=combobox][title="H3 极速草稿"]'),'Draft model display regressed');
  await wait(()=>button(${JSON.stringify(expected)}),'Source version header mismatch');
  window.__desktopTestMarker='preserved';`);
 await capture('web-sync-final.png');
 return {...api,qwenFiveModes:true,removeMaskEditor:true,angleScopes:true,missingStyleModelGuard:true,draftDefaultModel:true,noGenerationSubmitted:true};
 } finally {
  setModelCatalog(null);
 }
}
module.exports={verifyWebSync};

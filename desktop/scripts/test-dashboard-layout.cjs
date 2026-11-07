'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');const {spawn}=require('node:child_process');
(async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'dashboard-layout-'));let child;
 try{const env={...process.env,DESKTOP_LAYOUT_FIXTURE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
 child=spawn(require('electron'),[path.resolve(__dirname,'../test/dashboard-layout-fixture.cjs')],{env,stdio:'inherit',windowsHide:true});
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Layout fixture exceeded deadline'));},30000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',c=>{clearTimeout(timer);resolve(c)});});assert.equal(code,0,'Dashboard layout checks failed');
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('dashboard-layout-'));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});}
})().catch(error=>{console.error(error);process.exitCode=1;});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createPromptOptimizer } from '../src/prompt-optimizer.js';
const rootDir=path.resolve(import.meta.dirname,'..');
for(const apiFormat of ['responses','gemini','anthropic','grok'])test(`shared prompt optimization uses ${apiFormat} selected in cloud settings`,async t=>{
 let captured;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  captured={url:req.url,body:JSON.parse(raw),headers:req.headers};
  const content='A red cube on a wooden table.';
  const reply=apiFormat==='responses'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:content}]}]}:apiFormat==='gemini'?{candidates:[{content:{parts:[{text:content}]},finishReason:'STOP'}]}:apiFormat==='anthropic'?{content:[{type:'text',text:content}],stop_reason:'end_turn'}:{choices:[{message:{content}}]};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const optimizer=createPromptOptimizer({config:{rootDir},comfy:null,logger:null});
 const result=await optimizer.optimizeImage({prompt:'red cube',engine:'cloud',cloud:{baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test-only-key',model:'test-model',apiFormat}});
 assert.match(result.prompt,/red cube/);
 assert.equal(captured.url,apiFormat==='responses'?'/v1/responses':apiFormat==='gemini'?'/v1beta/models/test-model:generateContent':apiFormat==='anthropic'?'/v1/messages':'/v1/chat/completions');
 assert.equal(captured.headers[apiFormat==='gemini'?'x-goog-api-key':apiFormat==='anthropic'?'x-api-key':'authorization'],apiFormat==='gemini'||apiFormat==='anthropic'?'test-only-key':'Bearer test-only-key');
});

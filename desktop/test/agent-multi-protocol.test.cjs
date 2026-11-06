'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeAgentBaseUrl,resolveAgentRuntime}=require('../../infinite-canvas/web/src/lib/agent-cloud-config.ts');
const {readAgentChatResponse}=require('../../infinite-canvas/web/src/lib/agent-chat-stream.ts');

test('protocol bases preserve prefixes and strip operation endpoints without copying credentials',()=>{
 for(const [format,input,expected] of [
  ['responses','https://provider.example/v1/responses','https://provider.example/v1'],
  ['anthropic','https://provider.example/proxy/v1/messages','https://provider.example/proxy/v1'],
  ['gemini','https://generativelanguage.googleapis.com','https://generativelanguage.googleapis.com/v1beta'],
  ['gemini','https://provider.example/v1beta/models/gemini-test:streamGenerateContent','https://provider.example/v1beta'],
  ['gemini','https://provider.example/v1beta/models/gemini-test:generateContent','https://provider.example/v1beta'],
  ['grok','https://api.x.ai','https://api.x.ai/v1'],
 ]) assert.equal(normalizeAgentBaseUrl(input,format),expected);
 for(const apiFormat of ['openai','responses','gemini','anthropic','grok']) {
  const runtime=resolveAgentRuntime({transport:'cloud',enabled:true,localBaseUrl:''},{baseUrl:'https://provider.example',apiKey:'test-only',model:'exact/provider-name',apiFormat});
  assert.equal(runtime.apiFormat,apiFormat);assert.equal(runtime.model,'exact/provider-name');assert.equal(runtime.developer,false);
 }
});

test('opaque provider continuation is retained for JSON and SSE tools',async()=>{
 const metadata={gemini:{parts:[{functionCall:{name:'canvas_get_state',args:{}},thoughtSignature:'test-signature'}]}};
 const call={id:'test-id',function:{name:'canvas_get_state',arguments:'{}',thoughtSignature:'test-signature'}};
 const message={content:'',tool_calls:[call],provider_metadata:metadata};
 const reply=await readAgentChatResponse(new Response(JSON.stringify({choices:[{message}]}),{headers:{'content-type':'application/json'}}));
 assert.deepEqual(reply.providerMetadata,metadata);assert.equal(reply.toolCalls[0].function.thoughtSignature,'test-signature');
 const body='data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...call}]}}]})+'\n\n'+'data: '+JSON.stringify({choices:[{delta:{provider_metadata:metadata}}]})+'\n\ndata: [DONE]\n\n';
 const streamed=await readAgentChatResponse(new Response(body,{headers:{'content-type':'text/event-stream'}}));
 assert.deepEqual(streamed.providerMetadata,metadata);assert.deepEqual(streamed.toolCalls,reply.toolCalls);
});

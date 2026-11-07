'use strict';
// Verify the shipped gateway with Electron's embedded Node, no real cloud calls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { readAgentChatResponse } = require('../../infinite-canvas/web/src/lib/agent-chat-stream.ts');
(async () => {
  const appDir = path.resolve(__dirname, '../release/win-unpacked');
  const runtime = path.join(appDir, 'resources/runtime');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-agent-'));
  const { createAgentModelFixture, FIXTURE_KEY, FIXTURE_MODEL } = await import('../test/agent-cloud-model-fixture.mjs');
  const model = await createAgentModelFixture();
  let child;
  let output = '';
  try {
    const entry = path.join(temporary, 'gateway.mjs');
    await fs.writeFile(entry, `import {pathToFileURL} from 'node:url';\nimport http from 'node:http';\nimport path from 'node:path';\nconst {createGatewayApp,stopGateway}=await import(pathToFileURL(process.env.TEST_GATEWAY_ENTRY));\nconst app=await createGatewayApp({desktopDistribution:true,scanOnStart:false,watchWorkflows:false,updateEnabled:false,comfyUrl:'http://127.0.0.1:1',comfyDir:'',comfyWorkflowsDir:'',comfyFrontendDir:'',dataDir:path.join(process.cwd(),'data'),outputDir:path.join(process.cwd(),'outputs'),workflowDir:path.join(process.cwd(),'workflows'),corsOrigins:['http://127.0.0.1:24183']});\nconst server=http.createServer(app.app);\nawait new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));\nprocess.send({url:'http://127.0.0.1:'+server.address().port});\nasync function stop(){await stopGateway({...app,server});process.exit(0);}\nprocess.on('message',message=>{if(message==='shutdown')void stop()});\nprocess.on('disconnect',()=>void stop());\n`);
    child = fork(entry, [], { execPath: path.join(appDir, 'ComfyCanvas.exe'), execArgv: [], cwd: temporary,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DISABLE_NODE_BOOTSTRAP: '1', ASSISTANT_ENABLED: '0',
        TEST_GATEWAY_ENTRY: path.join(runtime, 'comfyui-gateway/src/server.js'),
        DATA_DIR: path.join(temporary,'data'), OUTPUT_DIR: path.join(temporary,'outputs'), WORKFLOW_DIR: path.join(temporary,'workflows'),
        GATEWAY_TOKEN:'', ALLOW_REMOTE:'0', COMFYUI_DIR:'', COMFY_WORKFLOWS_DIR:'', COMFY_FRONTEND_DIR:'',
      }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [ready] = await Promise.race([once(child,'message'), once(child,'exit').then(()=>{throw new Error('Packaged gateway exited before ready')}), new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Packaged gateway startup timeout')),20000);timer.unref();})]);
    for (const body of [{baseUrl:model.url,apiKey:FIXTURE_KEY,model:FIXTURE_MODEL},{clear:true}]) {
      const response=await fetch(`${ready.url}/api/agent/provider`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,409);assert.equal((await response.json()).error.code,'desktop_provider_sync_disabled');
    }
    await assert.rejects(fs.stat(path.join(runtime,'assistant','agent-provider.json')),{code:'ENOENT'});
    const request = async (operation, payload) => {
      const response = await fetch(`${ready.url}/api/agent/cloud/${operation}`, { method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:24183'},
        body:JSON.stringify({baseUrl:model.url,apiKey:FIXTURE_KEY,...(payload?{request:payload}:{})}),signal:AbortSignal.timeout(15000) });
      assert.equal(response.status,200);
      return response;
    };
    assert.equal((await (await request('models')).json()).data[0].id,FIXTURE_MODEL);
    const messages = [{role:'user',content:'Create a fixture text card'}];
    const tools = ['canvas_get_state','canvas_apply_ops'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}));
    const turn = () => request('chat',{model:FIXTURE_MODEL,messages,tools,stream:true,tool_choice:'auto'}).then(response=>readAgentChatResponse(response,{apiKey:FIXTURE_KEY}));
    const read = await turn(); assert.equal(read.toolCalls[0].function.name,'canvas_get_state');
    messages.push({role:'assistant',content:null,tool_calls:read.toolCalls.map(call=>({...call,type:'function'}))},{role:'tool',tool_call_id:read.toolCalls[0].id,content:'{"nodes":[]}'});
    const write = await turn(); assert.equal(write.toolCalls[0].function.name,'canvas_apply_ops');
    messages.push({role:'assistant',content:null,tool_calls:write.toolCalls.map(call=>({...call,type:'function'}))},{role:'tool',tool_call_id:write.toolCalls[0].id,content:'{"ok":true}'});
    assert.match((await turn()).content,/CLOUD_AGENT_UI_OK/);
    assert.equal(model.calls.filter(call=>call.kind==='chat').length,3);
    assert.ok(model.calls.every(call=>!call.keyInMessages && call.kind!=='failure'));
    child.send('shutdown'); assert.equal((await once(child,'exit'))[0],0);
    assert.equal(output.includes(FIXTURE_KEY),false);
    const entries = await fs.readdir(temporary,{recursive:true,withFileTypes:true});
    for(const entry of entries){if(entry.isFile())assert.equal((await fs.readFile(path.join(entry.parentPath||entry.path,entry.name),'utf8')).includes(FIXTURE_KEY),false,entry.name);}
    console.log('PACKAGED_AGENT_TEST_OK '+JSON.stringify({cloudModels:true,cloudChat:true,toolRoundTrip:true,keyNotLogged:true,realCloudCalls:false}));
  } finally {
    if(child && child.exitCode===null){if(child.connected)child.send('shutdown');await Promise.race([once(child,'exit'),new Promise(resolve=>{const timer=setTimeout(resolve,5000);timer.unref();})]);if(child.exitCode===null)child.kill();}
    await model.close();
    assert.equal(path.dirname(temporary),os.tmpdir());assert.ok(path.basename(temporary).startsWith('packaged-agent-'));
    await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

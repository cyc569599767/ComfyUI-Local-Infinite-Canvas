// Isolated browser acceptance environment; all writable files are temporary.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createGatewayApp, stopGateway } from '../../comfyui-gateway/src/server.js';
import { createCanvasServer } from '../../launcher/start.mjs';
import { createAgentModelFixture, FIXTURE_MODEL } from './agent-cloud-model-fixture.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-ui-'));
const listen = async server => { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return `http://127.0.0.1:${server.address().port}`; };
process.env.DISABLE_NODE_BOOTSTRAP = '1';
process.env.ASSISTANT_ENABLED = '0';
const mock = await createAgentModelFixture({ historyMode: process.argv.includes('--history') });
const gateway = await createGatewayApp({
  desktopDistribution:true, dataDir:path.join(temporary,'data'), outputDir:path.join(temporary,'outputs'), workflowDir:path.join(temporary,'workflows'),
  comfyUrl:'http://127.0.0.1:1', comfyDir:'', comfyWorkflowsDir:'', comfyFrontendDir:'',
  canvasDist:path.join(root,'desktop/.build/agent-ui-dist'), scanOnStart:false,watchWorkflows:false,updateEnabled:false,
});
const server=http.createServer(gateway.app);
const gatewayUrl=await listen(server);
const canvas=createCanvasServer({canvasDist:gateway.config.canvasDist,gatewayUrl,gatewayPort:server.address().port,canvasHost:'127.0.0.1'});
const canvasUrl=await listen(canvas);
gateway.config.corsOrigins.push(canvasUrl);
const report = http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({calls:mock.calls}));});
const reportUrl=await listen(report);
const identity={canvasUrl,gatewayUrl,modelUrl:mock.url,model:FIXTURE_MODEL,reportUrl,temporary};
const out=path.join(root,'desktop/test/artifacts/agent-cloud-ui');await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'environment.json'),JSON.stringify(identity,null,2));
console.log('AGENT_UI_FIXTURE_READY '+JSON.stringify(identity));
let stopping=false;
async function close(){if(stopping)return;stopping=true;canvas.closeAllConnections();canvas.close();report.closeAllConnections();report.close();await stopGateway({...gateway,server});await mock.close();await fs.rm(temporary,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);

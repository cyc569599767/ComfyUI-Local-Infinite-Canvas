import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLocalGpuAdmission, createGuardedCaption } from '../src/local-gpu-guard.js';
import { createComfyClient } from '../src/comfy-client.js';
import { createKvmemRuntime } from '../src/kvmem-runtime.js';

const config = {modelPath:fileURLToPath(import.meta.url),gpuDevice:'0'};
function fixture(options={}) {
 const admission=createLocalGpuAdmission(); let free=0,called=0,busy=false;
 const runtime={capability:()=>({available:true}),isBusy:()=>busy,caption:async()=>{called++;return {prompt:'ok',released:true};},close:async()=>{busy=false;},...options.runtime};
 const comfy={queue:async()=>({queue_running:[],queue_pending:[]}),freeMemory:async()=>{free++;},systemStats:async()=>({devices:[{index:0,type:'cuda',vram_free:16*1024**3,torch_vram_free:0}]}),...options.comfy};
 const guarded=createGuardedCaption({...options,admission,comfy,runtime,config,pendingTasks:options.pendingTasks||(()=>[])});
 return {admission,runtime,comfy,guarded,counts:()=>({free,called}),setBusy:x=>{busy=x;}};
}
test('admission prevents both overlapping submissions and overlapping captions',()=>{
 const a=createLocalGpuAdmission();const done=a.beginComfySubmission();assert.throws(()=>a.reserve(),/GPU/);done();done();const release=a.reserve();assert.throws(()=>a.beginComfySubmission(),/KVMem/);assert.throws(()=>a.reserve(),/GPU/);release();const next=a.beginComfySubmission();next();
});
test('idle successful caption unloads Comfy first and holds reservation through runtime',async()=>{
 const f=fixture();f.runtime.caption=async()=>{assert.equal(f.admission.busy(),true);assert.throws(()=>f.admission.beginComfySubmission());assert.equal(f.counts().free,1);return {prompt:'ok',released:true};};
 assert.equal((await f.guarded.run({})).released,true);assert.equal(f.admission.busy(),false);
});
test('Comfy active, pending and gateway queued tasks reject without free or launch',async()=>{
 for(const options of [{comfy:{queue:async()=>({queue_running:[[1]],queue_pending:[]})}},{comfy:{queue:async()=>({queue_running:[],queue_pending:[[1]]})}},{pendingTasks:()=>[{status:'queued'}]}]){
 const f=fixture(options);await assert.rejects(f.guarded.run({}),{code:'local_gpu_busy'});assert.deepEqual(f.counts(),{free:0,called:0});assert.equal(f.admission.busy(),false);
 }
});
test('unknown queue fails closed',async()=>{const f=fixture({comfy:{queue:async()=>({})}});await assert.rejects(f.guarded.run({}),{code:'local_gpu_queue_unknown'});assert.equal(f.counts().called,0);});
test('external process needs physical VRAM, not torch cached free',async()=>{
 const f=fixture({settleTimeoutMs:0,comfy:{systemStats:async()=>({devices:[{index:0,type:'cuda',vram_free:16*1024**3,torch_vram_free:16*1024**3}]})}});
 await assert.rejects(f.guarded.run({}),{code:'kvmem_insufficient_vram'});assert.equal(f.counts().called,0);assert.equal(f.admission.busy(),false);
});
test('no selected GPU or unknown stats never launch',async()=>{const f=fixture({settleTimeoutMs:0,comfy:{systemStats:async()=>({devices:[]})}});await assert.rejects(f.guarded.run({}),{code:'kvmem_insufficient_vram'});});
test('cancelled preflight and runtime error release only when child is gone',async()=>{
 const c=new AbortController();c.abort();const f=fixture();await assert.rejects(f.guarded.run({signal:c.signal}));assert.deepEqual(f.counts(),{free:0,called:0});
 f.runtime.caption=async()=>{throw Error('runtime failed');};await assert.rejects(f.guarded.run({}),/runtime failed/);assert.equal(f.admission.busy(),false);
 f.runtime.caption=async()=>{f.setBusy(true);throw Error('cleanup failed');};await assert.rejects(f.guarded.run({}),/cleanup failed/);assert.equal(f.admission.busy(),true);await f.guarded.close();assert.equal(f.admission.busy(),false);
});
test('new external Comfy queue entry during release prevents worker launch',async()=>{let n=0;const f=fixture({comfy:{queue:async()=>({queue_running:n++?[[1]]:[],queue_pending:[]})}});await assert.rejects(f.guarded.run({}),{code:'local_gpu_busy'});assert.equal(f.counts().called,0);});

// A timed-out HTTP submission can still be validating on the Comfy worker. An
// empty queue before that handler enqueues is not evidence of non-acceptance.
test('unknown timed-out Comfy submission blocks KVMem before and after delayed enqueue', async () => {
  let arrived;
  const arrival = new Promise(resolve => { arrived = resolve; });
  let publish;
  let postCount = 0;
  const queue = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/prompt') {
      res.writeHead(404).end();
      return;
    }
    postCount++;
    req.resume();
    publish = () => {
      queue.push(['late-workflow']);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ prompt_id: 'late-workflow', node_errors: {} }));
    };
    arrived();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const f = fixture({ comfy: { queue: async () => ({ queue_running: [], queue_pending: queue }) } });
    const client = createComfyClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 250,
      retryAttempts: 1, autoDiscover: false, gpuAdmission: f.admission });
    const failed = assert.rejects(client.submit({}), { code: 'comfy_aborted' });
    await arrival;
    await failed;
    assert.deepEqual(queue, [], 'the original handler has not yet enqueued');
    await assert.rejects(f.guarded.run({}), { code: 'local_gpu_submission_unknown' });
    assert.deepEqual(f.counts(), { free: 0, called: 0 }, 'unknown submission must not unload or start another worker');
    publish();
    assert.equal(queue.length, 1, 'the timed-out request still reaches the Comfy queue');
    await assert.rejects(f.guarded.run({}), { code: 'local_gpu_submission_unknown' });
    queue.length = 0;
    assert.throws(() => f.admission.reserve(), { code: 'local_gpu_submission_unknown' }, 'a later empty snapshot cannot erase unknown acceptance');
    const release = f.admission.beginComfySubmission();
    release();
    assert.equal(postCount, 1, 'submission is never retried');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('late owned-worker close reconciles the retained guard for both Comfy and caption admission', async () => {
  for (const next of ['comfy', 'caption']) {
    const children = [];
    let id;
    const runtime = createKvmemRuntime({
      config: { enabled: true, installDir: path.resolve('inert-install'), modelPath: path.resolve('inert-model.ninfer'),
        gpuDevice: '0', startupTimeoutMs: 1000, requestTimeoutMs: 1000 },
      fileExists: () => true, freePort: async () => 46125, stopTimeoutMs: 2,
      spawnImpl(_exe, args) {
        id = args[args.indexOf('--model-id') + 1];
        const child = new EventEmitter();
        child.kill = () => true; // Simulate delayed OS close beyond both stop deadlines.
        children.push(child);
        return child;
      },
      fetchImpl: async url => new Response(JSON.stringify(new URL(url).pathname === '/v1/models' ? { data: [{ id }] }
        : new URL(url).pathname === '/props' ? { backend: 'ninfer', modalities: { vision: true } }
        : new URL(url).pathname === '/v1/chat/completions' ? { model: id, choices: [{ message: { content: 'A square.' }, finish_reason: 'stop' }] }
        : { status: 'ok' }), { headers: { 'content-type': 'application/json' } }),
    });
    const f = fixture({ runtime });
    const input = { imageDataUrl: 'data:image/png;base64,aGVsbG8=', userPrompt: 'Describe.' };
    try {
      await assert.rejects(f.guarded.run(input), { code: 'kvmem_release_failed' });
      assert.equal(runtime.isBusy(), true);
      assert.equal(f.admission.busy(), true);
      assert.throws(() => f.admission.beginComfySubmission(), { code: 'local_gpu_busy' });
      assert.throws(() => f.admission.reserve(), { code: 'local_gpu_busy' });
      children[0].emit('close', 0);
      assert.equal(runtime.isBusy(), false, 'late close is the authoritative exit confirmation');
      const release = next === 'comfy' ? f.admission.beginComfySubmission() : f.admission.reserve();
      release();
      assert.equal(f.admission.busy(), false, `${next} admission must reconcile only after verified child close`);
      assert.equal(children.length, 1, 'reconciliation does not restart or attach a process');
    } finally {
      if (runtime.isBusy()) children[0]?.emit('close', 0);
      await f.guarded.close();
    }
  }
});

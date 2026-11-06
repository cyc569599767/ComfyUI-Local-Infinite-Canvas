// Offline OpenAI-compatible fixture: never contacts a provider or runs ComfyUI.
import http from 'node:http';
import assert from 'node:assert/strict';
export const FIXTURE_KEY = 'fixture-agent-key-not-a-secret';
export const FIXTURE_MODEL = 'fixture-cloud-model-exact';
export async function createAgentModelFixture({ historyMode = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${FIXTURE_KEY}`);
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'GET' && req.url === '/v1/models') {
        calls.push({ kind: 'models' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: FIXTURE_MODEL }] }));
      }
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      let data = ''; for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      assert.equal(body.model, FIXTURE_MODEL);
      assert.equal(body.stream, true);
      assert.ok(body.tools?.some(tool => tool.function.name === 'canvas_apply_ops'));
      if (historyMode) {
        const serial = calls.filter(call => call.kind === 'chat').length + 1;
        const last = body.messages.findLast(item => item.role === 'user');
        const lastText = typeof last?.content === 'string' ? last.content : last?.content?.find(part => part.type === 'text')?.text || '';
        calls.push({ kind: 'chat', serial, model: body.model, lastText, userTexts: body.messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : '[image]'), assistantTexts: body.messages.filter(item => item.role === 'assistant').map(item => item.content), keyInMessages: JSON.stringify(body.messages).includes(FIXTURE_KEY) });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `回复${serial}：${lastText}` } }] })}\n\n`);
        // Keep the response live briefly to exercise disabled message controls/cancel.
        const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 800);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      const lastUserIndex = body.messages.findLastIndex(item => item.role === 'user');
      const turn = body.messages.slice(lastUserIndex + 1);
      const responses = turn.filter(item => item.role === 'tool');
      calls.push({ kind: 'chat', model: body.model, toolResults: responses.length,
        validTools: true, keyInMessages: JSON.stringify(body.messages).includes(FIXTURE_KEY) });
      let delta;
      if (responses.length === 0) {
        delta = { tool_calls: [{ index: 0, id: 'cloud-read-state', type: 'function', function: { name: 'canvas_get_state', arguments: '{}' } }] };
      } else if (responses.length === 1) {
        delta = { tool_calls: [{ index: 0, id: 'cloud-create-node', type: 'function', function: { name: 'canvas_apply_ops', arguments: JSON.stringify({ ops: [
          { type: 'add_node', id: 'cloud-agent-fixture-node', nodeType: 'text', title: '云端 Agent 验证卡片', position: {x:100,y:100}, metadata: { content: '由本地模拟云端模型创建，无真实云端请求。' } },
        ] }) } }] };
      } else {
        const last = JSON.parse(responses.at(-1).content);
        delta = { content: last.ok ? 'CLOUD_AGENT_UI_OK：已创建验证卡片。' : 'CLOUD_AGENT_UI_REJECTED：未修改画布。' };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({choices:[{delta}]})}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      calls.push({kind:'failure',message:error.message.split(FIXTURE_KEY).join('[redacted]')});
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: {message:'Fixture request contract failed'} }));
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
  return { server, calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}) };
}

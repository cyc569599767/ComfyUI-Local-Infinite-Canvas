'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAgentBaseUrl, resolveAgentRuntime, persistedPromptCloudConfig } = require('../../infinite-canvas/web/src/lib/agent-cloud-config.ts');

test('cloud API URLs accept origins, version/custom bases and full chat paths', () => {
  for (const [input, output] of [
    ['https://api.example', 'https://api.example/v1'],
    ['https://api.example/v1/', 'https://api.example/v1'],
    ['https://api.example/compatible-mode/v1/chat/completions', 'https://api.example/compatible-mode/v1'],
    ['https://api.example/custom/models', 'https://api.example/custom'],
    ['http://127.0.0.1:18800', 'http://127.0.0.1:18800/v1'],
  ]) assert.equal(normalizeAgentBaseUrl(input), output);
  for (const input of ['no-url', 'file:///etc/passwd', 'http://api.example/v1', 'https://user:secret@api.example', 'https://api.example?api_key=key', 'https://api.example/#key']) {
    assert.throws(() => normalizeAgentBaseUrl(input));
  }
});

test('cloud runtime uses configured URL/key/model exactly and never inherits developer capability', () => {
  const input = { baseUrl: 'https://api.deepseek.com', apiKey: '  test-key  ', model: 'deepseek-chat' };
  assert.deepEqual(resolveAgentRuntime({ transport: 'cloud', enabled: true, localBaseUrl: 'http://127.0.0.1:18800' }, input), {
    transport: 'cloud', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-chat', apiFormat: 'openai', developer: false,
  });
  assert.equal(input.apiKey, '  test-key  ');
  for (const profile of [null, {...input, apiKey:''}, {...input, model:''}, {...input,baseUrl:''}]) {
    assert.throws(() => resolveAgentRuntime({transport:'cloud', enabled:false,localBaseUrl:''}, profile));
  }
});

test('local pi mode remains an explicit loopback-only choice and does not send a cloud key', () => {
  const cloud = {baseUrl:'https://cloud.example/v1',apiKey:'sensitive',model:'cloud-model'};
  const normal = resolveAgentRuntime({transport:'local',enabled:false,localBaseUrl:'http://127.0.0.1:18801'},cloud);
  assert.equal(normal.baseUrl,'http://127.0.0.1:18801/v1'); assert.equal(normal.apiKey,'');
  assert.equal(normal.model,'openclaw/canvas-agent'); assert.equal(normal.developer,false);
  const dev = resolveAgentRuntime({transport:'local',enabled:true,localBaseUrl:'http://127.0.0.1:18801'},cloud);
  assert.equal(dev.model,'openclaw/canvas-dev'); assert.equal(dev.developer,true);
  assert.throws(()=>resolveAgentRuntime({transport:'local',enabled:true,localBaseUrl:'https://remote.example'},cloud));
});

test('unremembered keys and the active mirror never enter persisted config', () => {
  const config = {promptCloudApiId:'a',promptCloudApiKey:'ephemeral',promptCloudApis:[
    {id:'a',baseUrl:'https://a.example',apiKey:'ephemeral',model:'a',rememberKey:false},
    {id:'b',baseUrl:'https://b.example',apiKey:'remembered',model:'b',rememberKey:true},
    {id:'c',baseUrl:'https://c.example',apiKey:'legacy',model:'c'},
  ]};
  const stored = persistedPromptCloudConfig(config);
  assert.equal(stored.promptCloudApiKey,''); assert.equal(stored.promptCloudApis[0].apiKey,'');
  assert.equal(stored.promptCloudApis[1].apiKey,'remembered'); assert.equal(stored.promptCloudApis[2].apiKey,'legacy');
  assert.equal(JSON.stringify(stored).includes('ephemeral'),false);
  assert.equal(config.promptCloudApis[0].apiKey,'ephemeral'); assert.equal(config.promptCloudApiKey,'ephemeral');
  assert.equal(persistedPromptCloudConfig({...config,promptCloudApiId:'b'}).promptCloudApiKey,'remembered');
});

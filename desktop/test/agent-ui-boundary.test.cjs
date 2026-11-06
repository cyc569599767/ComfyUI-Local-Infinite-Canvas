'use strict';
const fs=require('node:fs');const path=require('node:path');const test=require('node:test');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../infinite-canvas/web/src');
test('chat has model selection but no credential editing or connection-test controls',()=>{
 const source=fs.readFileSync(path.join(root,'components/agent/agent-cloud-chat.tsx'),'utf8');
 assert.match(source,/selectPromptCloudApi/);assert.match(source,/agent\.cloud\.selectModel/);
 for(const marker of ['Input.Password','testDevConnection','fetchAgentCloudModels','openCloudSettings','setLocalBaseUrl','agent.cloud.test','agent.cloud.configure'])assert.equal(source.includes(marker),false,marker);
 assert.match(source,/agent\.cloud\.configurationHint/);
 assert.match(source,/provider_metadata: reply\.providerMetadata/);
});
test('cloud preferences own URL/key/protocol and retain optional secret persistence',()=>{
 const source=fs.readFileSync(path.join(root,'components/layout/app-config-modal.tsx'),'utf8');
 for(const marker of ['name="baseUrl"','name="apiKey"','name="apiFormat"','name="rememberKey"'])assert.ok(source.includes(marker),marker);
 const store=fs.readFileSync(path.join(root,'stores/use-config-store.ts'),'utf8');
 assert.match(store,/persistedPromptCloudConfig\(state.config\)/);
 assert.match(store,/promptCloudApiFormat: normalizeAgentApiFormat/);
});

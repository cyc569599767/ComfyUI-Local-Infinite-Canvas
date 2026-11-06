'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {appendGenerationText}=require('../../infinite-canvas/web/src/lib/canvas/generation-prompt.ts');
test('upstream text expands once when absent and preserves input order',()=>{
 assert.equal(appendGenerationText('Base',[{label:'文本1',text:'Alpha'},{label:'文本2',text:'Beta'}]),'Base\n\n【文本1】\nAlpha\n\n【文本2】\nBeta');
});
test('editor-inserted text and repeated regeneration are not appended again',()=>{
 const refs=[{label:'文本1',text:'UNIQUE_CONTEXT'}];const prompt='Base\n\nUNIQUE_CONTEXT';
 assert.equal(appendGenerationText(prompt,refs),prompt);
 const initial=appendGenerationText('Base',refs);assert.equal(appendGenerationText(initial,refs),initial);
});
test('blank references are ignored and repeated identical references do not duplicate prompt',()=>{
 assert.equal(appendGenerationText('Base',[{label:'1',text:'   '}]),'Base');
 assert.equal(appendGenerationText('Base',[{label:'1',text:'Alpha'},{label:'2',text:'Alpha'}]),'Base\n\n【1】\nAlpha');
});

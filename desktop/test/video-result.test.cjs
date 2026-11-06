'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {isFinalVideoResult,isStillImageUrl,rejectStillImageBlob}=require('../../infinite-canvas/web/src/lib/video-result.ts');
test('pending tasks cannot complete merely because they have a preview URL',()=>{
 for(const status of ['queued','running','processing','pending','failed','cancelled'])assert.equal(isFinalVideoResult(status),false,status);
 for(const status of [undefined,'','completed','succeeded','success'])assert.equal(isFinalVideoResult(status),true,String(status));
});
test('known still image URLs are not final videos',()=>{
 for(const url of ['https://cdn/a.png?x=1','https://cdn/a.JPG#t','data:image/png;base64,a','/x.webp'])assert.equal(isStillImageUrl(url),true);
 assert.equal(isStillImageUrl('https://cdn/movie.mp4?token=1'),false);
});
test('image MIME and signatures are rejected even if disguised as MP4',async()=>{
 for(const bytes of [Buffer.from([0x89,0x50,0x4e,0x47,13,10,26,10]),Buffer.from([255,216,255,0]),Buffer.from('GIF89a'),Buffer.from('RIFFxxxxWEBP')])await assert.rejects(rejectStillImageBlob(new Blob([bytes],{type:'video/mp4'}),'invalid video'),/invalid video/);
 await assert.rejects(rejectStillImageBlob(new Blob(['x'],{type:'image/png'}),'invalid video'),/invalid video/);
 await rejectStillImageBlob(new Blob([Buffer.from('0000ftypisom')],{type:'video/mp4'}),'invalid video');
});

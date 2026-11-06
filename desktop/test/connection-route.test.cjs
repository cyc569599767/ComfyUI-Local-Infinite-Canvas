'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {buildConnectionRoute:route,connectionIntersectsView:visible,connectionLayerGeometry:layer}=require('../../infinite-canvas/web/src/lib/canvas/connection-route.ts');
const node=(id,x,y,w=160,h=100)=>({id,type:'image',position:{x,y},width:w,height:h});
test('connections preserve direct cubic shape and exact source/target ports',()=>{
 const r=route(node('a',30,120),node('b',300,220));
 assert.equal(r.d,'M 190 170 C 245 170, 245 270, 300 270');
 assert.deepEqual(r.bounds,{left:190,top:170,right:300,bottom:270});
});
test('long inherited connection is a single direct cubic with no detour',()=>{
 const r=route(node('ref',30,120),node('new',1172,225,340,194));
 assert.equal(r.d,'M 190 170 C 681 170, 681 322, 1172 322');
 assert.equal(/ L | Q /.test(r.d),false);
});
test('backwards curves include both control points in culling bounds',()=>{
 const r=route(node('a',600,120),node('b',100,120));
 assert.deepEqual(r.bounds,{left:-230,right:1090,top:170,bottom:170});
 assert.equal(visible(r.bounds,{left:-220,right:-100,top:160,bottom:180}),true);
});
test('negative coordinates and nodes beyond 10000 retain valid paths',()=>{
 for(const x of [-20000,30000]){const a=node('a',x,0),b=node('b',x+500,100);const r=route(a,b);assert.ok(r.d.startsWith(`M ${x+160} 50`));assert.equal(visible(r.bounds,{left:x,right:x+1000,top:0,bottom:500}),true);}
});
test('horizontal and vertical zero-area bounds remain visible at viewport edges',()=>{
 assert.equal(visible({left:0,right:500,top:100,bottom:100},{left:20,right:400,top:100,bottom:200}),true);
 assert.equal(visible({left:100,right:100,top:0,bottom:500},{left:100,right:200,top:20,bottom:400}),true);
 assert.equal(visible({left:0,right:50,top:0,bottom:50},{left:100,right:200,top:100,bottom:200}),false);
});
test('culling includes screen-size stroke padding at low zoom',()=>{
 const bounds={left:0,right:100,top:0,bottom:0};const view={left:0,right:100,top:100,bottom:200};
 assert.equal(visible(bounds,view,1),false);assert.equal(visible(bounds,view,0.05),true);
});
test('SVG origin and viewBox cancel so world coordinates stay aligned under pan and zoom',()=>{
 for(const scale of [0.05,0.25,1,5]) for(const tx of [-40000,0,27000]){
  const view={left:-tx/scale-280,top:-150/scale-280,right:(1800-tx)/scale+280,bottom:(1000-150)/scale+280};
  const l=layer(view);assert.equal(l.left,view.left);assert.equal(l.viewBox,`${l.left} ${l.top} ${l.width} ${l.height}`);
  const worldX=view.left+100;const svgScreenX=tx+(l.left+(worldX-view.left))*scale;
  assert.ok(Math.abs(svgScreenX-(tx+worldX*scale))<1e-8);
  assert.ok(l.width*scale<=1800+560*scale+1);
 }
});
test('SVG size is viewport-relative instead of a fixed positive 10000 canvas',()=>{
 assert.deepEqual(layer({left:-19000,top:23000,right:-18000,bottom:23600}),{left:-19000,top:23000,width:1000,height:600,viewBox:'-19000 23000 1000 600'});
 const l=layer({left:0,right:0,top:0,bottom:0});assert.equal(l.width,1);assert.equal(l.height,1);
});
test('moving/resizing endpoint recomputes its exact port and leaves graph data unchanged',()=>{
 const a=node('a',0,0),b=node('b',900,0);const before=JSON.stringify([a,b]);const r=route(a,b);assert.equal(JSON.stringify([a,b]),before);b.position.y=300;b.width=400;
 assert.notEqual(route(a,b).d,r.d);assert.ok(route(a,b).d.endsWith('900 350'));
});

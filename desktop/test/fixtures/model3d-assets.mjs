// Tiny synthetic meshes for offline UI acceptance; no inference or downloaded assets.
const vertices = new Float32Array([-1,-1,0, 1,-1,0, 0,1,0, 0,0,1.5]);
const indices = new Uint16Array([0,1,2, 0,3,1, 1,3,2, 2,3,0]);
const binary = Buffer.concat([Buffer.from(vertices.buffer), Buffer.from(indices.buffer)]);
const doc = {asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.12,0.7,0.45,1],metallicFactor:0,roughnessFactor:0.7}}],buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:48,target:34962},{buffer:0,byteOffset:48,byteLength:24,target:34963}],accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-1,-1,0],max:[1,1,1.5]},{bufferView:1,componentType:5123,count:12,type:'SCALAR'}]};
const json = Buffer.from(JSON.stringify(doc));const padding=(4-json.length%4)%4;const jsonChunk=Buffer.concat([json,Buffer.alloc(padding,32)]);
const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+jsonChunk.length+8+binary.length,8);
const jh=Buffer.alloc(8);jh.writeUInt32LE(jsonChunk.length,0);jh.writeUInt32LE(0x4e4f534a,4);const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
export const glb=Buffer.concat([header,jh,jsonChunk,bh,binary]);
const props=['x','y','z','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3','f_dc_0','f_dc_1','f_dc_2','opacity'];
export const ply=Buffer.from(['ply','format ascii 1.0','element vertex 4',...props.map(p=>'property float '+p),'end_header',...Array.from({length:4},(_,i)=>[...vertices.slice(i*3,i*3+3),-1.5,-1.5,-1.5,1,0,0,0,-0.8,0.7,-0.3,4].join(' ')),''].join('\n'));

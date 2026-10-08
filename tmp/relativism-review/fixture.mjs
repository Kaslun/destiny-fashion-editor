import fs from 'node:fs/promises';
const root='tmp/relativism-review';const asset=JSON.parse(await fs.readFile(`${root}/asset.json`,'utf8'));const variants=[];
for(const i of [0,2]) {
 const b=await fs.readFile(`${root}/geometry-${i}.tgxm`);const files={};
 for(let j=0;j<b.readUInt32LE(12);j++){const o=b.readUInt32LE(8)+j*272;files[b.subarray(o,o+256).toString().split('\0')[0]]=b.subarray(b.readUInt32LE(o+256),b.readUInt32LE(o+256)+b.readUInt32LE(o+264));}
 const m=JSON.parse(files['render_metadata.js']).render_model.render_meshes[0];
 const parts=m.stage_part_list.slice(m.stage_part_offsets[7],m.stage_part_offsets[8]).filter(p=>p.lod_category.value===0);
 const inds=[];for(const p of parts){let start=inds.length;for(let k=p.start_index;k<p.start_index+p.index_count;k++)inds.push(files[m.index_buffer.file_name].readUInt16LE(k*2));p.start_index=start;}
 const verts=[...new Set(inds.filter(x=>x!==65535))];const ids=new Map(verts.map((v,k)=>[v,k]));const ib=Buffer.alloc(inds.length*2);inds.forEach((v,k)=>ib.writeUInt16LE(v===65535?v:ids.get(v),k*2));
 const buffers={[m.index_buffer.file_name]:ib.toString('base64')};
 for(const vb of m.vertex_buffers) {const stride=vb.stride_byte_size;const result=Buffer.concat(verts.map(v=>files[vb.file_name].subarray(v*stride,(v+1)*stride)));buffers[vb.file_name]=result.toString('base64');vb.byte_size=result.length;}
 m.index_buffer.byte_size=ib.length;m.stage_part_list=parts;m.stage_part_offsets=Array.from({length:25},(_,k)=>k<=7?0:parts.length);m.stage_part_vertex_stream_layout_definitions=m.stage_part_vertex_stream_layout_definitions.slice(0,1);
 variants.push({file:asset.content[0].geometry[i].file,metadata:{render_model:{render_meshes:[m]}},buffers});
}
await fs.writeFile('lib/geometry/fixtures/prismatic-wisps.json',JSON.stringify({itemHash:2809120022,retrieved:'2026-10-01',note:'Real stage-7 LOD0 draws, both body variants. Original vertex bytes with unused vertices removed and indices remapped.',variants},null,2)+'\n');
const dyes=JSON.parse(await fs.readFile(`${root}/dyes.json`,'utf8')).rawGearFile.default_dyes;
const meshes=[];for(let i=0;i<4;i++){let m=JSON.parse(await fs.readFile(`${root}/metadata-${i}.json`,'utf8')).render_model.render_meshes[0];meshes.push({stage_part_list:m.stage_part_list,stage_part_offsets:m.stage_part_offsets});}
await fs.writeFile('lib/materials/fixtures/prismatic-program.json',JSON.stringify({itemHash:2809120022,retrieved:'2026-10-01',default_dyes:dyes,render_model:{render_meshes:meshes}},null,2)+'\n');

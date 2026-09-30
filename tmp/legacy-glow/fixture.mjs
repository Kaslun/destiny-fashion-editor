import fs from 'node:fs/promises';
const root='tmp/legacy-glow';const asset=JSON.parse(await fs.readFile(`${root}/asset.json`,'utf8'));const variants=[];
for(let i=0;i<2;i++) {
 const b=await fs.readFile(`${root}/geometry-${i}.tgxm`);const files={};
 for(let j=0;j<b.readUInt32LE(12);j++){const o=b.readUInt32LE(8)+j*272;files[b.subarray(o,o+256).toString().split('\0')[0]]=b.subarray(b.readUInt32LE(o+256),b.readUInt32LE(o+256)+b.readUInt32LE(o+264));}
 const m=JSON.parse(files['render_metadata.js']).render_model.render_meshes[0];
 const part=m.stage_part_list.slice(m.stage_part_offsets[7],m.stage_part_offsets[8]).find(p=>p.lod_category.value===0);
 const inds=[];for(let k=part.start_index;k<part.start_index+part.index_count;k++)inds.push(files[m.index_buffer.file_name].readUInt16LE(k*2));
 const verts=[...new Set(inds.filter(x=>x!==65535))];const ids=new Map(verts.map((v,k)=>[v,k]));const ib=Buffer.alloc(inds.length*2);inds.forEach((v,k)=>ib.writeUInt16LE(v===65535?v:ids.get(v),k*2));
 const buffers={[m.index_buffer.file_name]:ib.toString('base64')};
 for(const vb of m.vertex_buffers) {const stride=vb.stride_byte_size;const result=Buffer.concat(verts.map(v=>files[vb.file_name].subarray(v*stride,(v+1)*stride)));buffers[vb.file_name]=result.toString('base64');vb.byte_size=result.length;}
 m.index_buffer.byte_size=ib.length;m.stage_part_list=[{...part,start_index:0,index_min:0,index_max:verts.length-1}];m.stage_part_offsets=Array.from({length:25},(_,k)=>k<=7?0:1);m.stage_part_vertex_stream_layout_definitions=m.stage_part_vertex_stream_layout_definitions.slice(0,1);
 variants.push({file:asset.content[0].geometry[i].file,metadata:{render_model:{render_meshes:[m]}},buffers});console.log(i,verts.length,inds.length);
}
await fs.writeFile('lib/geometry/fixtures/atlas-hologram-effects.json',JSON.stringify({itemHash:1657654553,retrieved:'2026-09-30',note:'Real stage-7 LOD0 draws for both body variants. Original vertex bytes; unused vertices removed and indices remapped.',variants},null,2)+'\n');
await fs.copyFile(`${root}/3211931049_hun_exo_chest_gbit_512_256_2.img`,'lib/geometry/fixtures/atlas-hologram-gearstack.png');

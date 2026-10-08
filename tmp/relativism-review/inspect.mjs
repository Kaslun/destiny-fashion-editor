import fs from 'node:fs/promises';
const root='tmp/relativism-review';
const asset=JSON.parse(await fs.readFile(`${root}/asset.json`,'utf8'));
for(const [i,g] of asset.content[0].geometry.entries()) {
 const b=Buffer.from(await (await fetch(`http://localhost:3000${g.proxyUrl}`)).arrayBuffer());
 await fs.writeFile(`${root}/geometry-${i}.tgxm`,b);
 for(let j=0;j<b.readUInt32LE(12);j++) {
 const o=b.readUInt32LE(8)+j*272;
 const name=b.subarray(o,o+256).toString().split('\0')[0];
 if(name.includes('render_metadata')) {
 const m=JSON.parse(b.subarray(b.readUInt32LE(o+256),b.readUInt32LE(o+256)+b.readUInt32LE(o+264)).toString());
 await fs.writeFile(`${root}/metadata-${i}.json`,JSON.stringify(m,null,2));
 console.log(i,JSON.stringify(m.render_model.render_meshes.map(x=>({offsets:x.stage_part_offsets,parts:x.stage_part_list.filter(p=>p.shader?.static_textures?.length)})),null,2));
 }
 }
}


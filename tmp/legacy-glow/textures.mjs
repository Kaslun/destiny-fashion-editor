import fs from 'node:fs/promises';
const root='tmp/legacy-glow';const asset=JSON.parse(await fs.readFile(`${root}/asset.json`,'utf8'));
await Promise.all(asset.content[0].textures.map(async(g)=>{
 const b=Buffer.from(await (await fetch(`http://localhost:3000${g.proxyUrl}`)).arrayBuffer());
 for(let j=0;j<b.readUInt32LE(12);j++) {
 const o=b.readUInt32LE(8)+j*272;const name=b.subarray(o,o+256).toString().split('\0')[0];
 await fs.writeFile(`${root}/${name}.img`,b.subarray(b.readUInt32LE(o+256),b.readUInt32LE(o+256)+b.readUInt32LE(o+264)));
 console.log(name);
 }
}));

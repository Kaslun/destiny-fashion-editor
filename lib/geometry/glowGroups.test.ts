import { expect, it } from "vitest";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { partitionGlowGroups } from "./glowGroups";
import type { GroupInfo } from "./buildGeometry";

it("splits mixed glow/cloth/metal groups by whole triangles, preserving every index and dye assignment", () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute("uv", new Float32BufferAttribute([
    0.1,0.1, 0.2,0.1, 0.2,0.2, // glow
    0.6,0.6, 0.7,0.6, 0.7,0.7, // opaque
    0.1,0.1, 0.7,0.6, 0.7,0.7, // boundary: one vertex in glow isn't enough
  ],2));
  geometry.setIndex([0,1,2,3,4,5,6,7,8]); geometry.addGroup(0,9,0);
  const groups: GroupInfo[] = [{ dyeIndex: 2, decal: false }];
  partitionGlowGroups(geometry, groups, {size:[100,100],placements:[{name:"eye_glow",x:0,y:0,w:50,h:50}]});
  expect(geometry.groups).toEqual([{start:0,count:3,materialIndex:0},{start:3,count:6,materialIndex:1}]);
  expect(groups.map((g)=>[g.dyeIndex,g.glow])).toEqual([[2,true],[2,false]]);
  expect([...geometry.getIndex()!.array]).toEqual([0,1,2,3,4,5,6,7,8]);
});

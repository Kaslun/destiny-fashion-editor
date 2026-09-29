import type { BufferGeometry } from "three";
import type { GroupInfo } from "./buildGeometry";
import type { TexturePlate } from "./renderMetadata";

/** Separate glow triangles from ordinary surfaces; a majority vote must never
 * turn an entire mixed draw call into an additive, self-lit material.
 */
export function partitionGlowGroups(geometry: BufferGeometry, groups: GroupInfo[], plate?: TexturePlate): void {
  const uv = geometry.getAttribute("uv"), index = geometry.getIndex();
  if (!plate || !uv || !index) return;
  const [width, height] = plate.size;
  const rects = plate.placements.filter((p) => /glow|hawkeye/i.test(p.name))
    .map((p) => ({ left: p.x / width, right: (p.x + p.w) / width, top: p.y / height, bottom: (p.y + p.h) / height }));
  if (!rects.length) return;
  const original = [...geometry.groups];
  const resolved: GroupInfo[] = [];
  const reordered: number[] = [];
  geometry.clearGroups();
  for (const group of original) {
    const info = groups[group.materialIndex ?? -1];
    if (!info) continue;
    // At most two draws per original group, even when glow triangles alternate.
    const buckets = new Map<boolean, number[]>();
    const end = group.start + group.count;
    for (let i = group.start; i < end; i += 3) {
      const glow = rects.some((r) => [0, 1, 2].every((c) => {
        const v = index.getX(i + c), x = uv.getX(v), y = uv.getY(v);
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }));
      const bucket = buckets.get(glow) ?? [];
      bucket.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
      buckets.set(glow, bucket);
    }
    for (const [glow, bucket] of buckets) {
      geometry.addGroup(reordered.length, bucket.length, resolved.length);
      for (const vertex of bucket) reordered.push(vertex);
      resolved.push({ ...info, glow });
    }
  }
  geometry.setIndex(reordered);
  groups.splice(0, groups.length, ...resolved);
}

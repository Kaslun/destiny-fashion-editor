import { BufferAttribute, type BufferGeometry } from "three";
import type { GroupInfo } from "./buildGeometry";

export function matchRayTextureNames(names: string[] = []): { height?: string; smoke?: string } {
  return {
    height: names.find((n) => n.toLowerCase().endsWith("_vfx_godray_a_height")),
    smoke: names.find((n) => n.toLowerCase().endsWith("_smoke_soft_wispy_plate")),
  };
}

export function isRayGlowGroup(group: GroupInfo): boolean {
  const { height, smoke } = matchRayTextureNames(group.patternTextures);
  return group.renderStage === 7 && group.shaderType === 8 && !!height && !!smoke;
}

export function matchCloudTextureNames(names: string[] = []): { palette?: string; cloud?: string; mask?: string } {
  return {
    palette: names.find((n) => n.toLowerCase().endsWith("_taken_stain_etch_palette")),
    cloud: names.find((n) => n.toLowerCase().endsWith("_digital_cloud_plate")),
    mask: names.find((n) => n.toLowerCase().endsWith("_dust_snow_mask_med01")),
  };
}

export type TransparentEffect = { kind: "ray-glow" | "digital-cloud"; textures: string[] };

/** Stage establishes transparency; complete texture signatures select a preview.
 * A shader number or one shared texture alone never determines the effect.
 */
export function transparentEffect(group: GroupInfo): TransparentEffect | undefined {
  if (group.renderStage !== 7 || group.shaderType !== 8) return;
  if (isRayGlowGroup(group)) {
    const { height, smoke } = matchRayTextureNames(group.patternTextures);
    return { kind: "ray-glow", textures: [height!, smoke!] };
  }
  const { palette, cloud, mask } = matchCloudTextureNames(group.patternTextures);
  if (palette && cloud && mask) return { kind: "digital-cloud", textures: [palette, cloud, mask] };
}

/** Mobile exports pack effect UV islands into armor-atlas regions.
 * Recover local coordinates per connected card/ribbon for approximate effects.
 * Never normalize all effects together: disconnected ribbons can overlap in UV.
 * Armor UVs, positions, indices and draw assignments remain unchanged.
 */
export function prepareEffectUVs(geometry: BufferGeometry, groups: GroupInfo[]): boolean {
  if (!groups.some(transparentEffect)) return false;
  const uv = geometry.getAttribute("uv"), index = geometry.getIndex();
  if (!uv || !index) return false;
  const data = new Float32Array(uv.count * 2);
  let found = false;
  for (const draw of geometry.groups) {
    const group = groups[draw.materialIndex ?? -1];
    if (!group || !transparentEffect(group)) continue;
    const parents = new Map<number, number>();
    const root = (v: number): number => {
      if (!parents.has(v)) parents.set(v, v);
      let r = v;
      while (parents.get(r) !== r) r = parents.get(r)!;
      while (v !== r) { const next = parents.get(v)!; parents.set(v, r); v = next; }
      return r;
    };
    for (let i = draw.start; i < draw.start + draw.count; i += 3) {
      const a = root(index.getX(i));
      parents.set(root(index.getX(i + 1)), a);
      parents.set(root(index.getX(i + 2)), a);
    }
    const islands = new Map<number, number[]>();
    for (const v of parents.keys()) {
      const r = root(v), island = islands.get(r) ?? [];
      island.push(v); islands.set(r, island);
    }
    for (const island of islands.values()) {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const v of island) {
        left = Math.min(left, uv.getX(v)); right = Math.max(right, uv.getX(v));
        top = Math.min(top, uv.getY(v)); bottom = Math.max(bottom, uv.getY(v));
      }
      if (right - left < 1e-7 || bottom - top < 1e-7) continue;
      found = true;
      for (const v of island) {
        data[v * 2] = (uv.getX(v) - left) / (right - left);
        data[v * 2 + 1] = (uv.getY(v) - top) / (bottom - top);
      }
    }
  }
  if (found) geometry.setAttribute("effectUv", new BufferAttribute(data, 2));
  return found;
}

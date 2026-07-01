/**
 * Texture container (.tgxm.bin) parsing.
 *
 * Texture containers use the same TGXM archive format as geometry, but hold
 * complete image files (PNG or JPEG — the browser decodes either directly).
 *
 * Bungie's mobile "gbit" texture-plate system splits one logical material
 * texture across suffixed entries / resolution-tiered containers:
 *   `..._gbit_1024_1024_0`  -> plate 0 = diffuse / albedo   (usually JPEG)
 *   `..._gbit_512_512_1`    -> plate 1 = normal              (PNG)
 *   `..._gbit_512_512_2`    -> plate 2 = gearstack           (PNG, material mask)
 * Detail textures use `_dif` / `_norm` / `_overdif` suffixes instead.
 *
 * Which containers apply to which mesh is resolved by `region_index_sets` in the
 * gear-asset content (see loadGearModel.ts), not here.
 */
import { parseTgxm } from "./tgxm";

export type TexRole = "diffuse" | "normal" | "gearstack" | "other";

export interface TexImage {
  name: string;
  role: TexRole;
  bytes: Uint8Array;
  size: number;
}

export function classifyTextureRole(name: string): TexRole {
  const n = name.toLowerCase();
  if (n.includes("gearstack") || /_2$/.test(n)) return "gearstack";
  if (n.endsWith("_norm") || n.endsWith("_normal") || /_1$/.test(n)) return "normal";
  if (
    /_0$/.test(n) ||
    n.endsWith("_dif") ||
    n.endsWith("_overdif") ||
    n.endsWith("_diffuse")
  ) {
    return "diffuse";
  }
  return "other";
}

/** Parse a texture container into classified image entries. */
export function extractTextureImages(buf: ArrayBuffer): TexImage[] {
  const container = parseTgxm(buf);
  return container.files.map((f) => ({
    name: f.name,
    role: classifyTextureRole(f.name),
    bytes: f.data,
    size: f.size,
  }));
}

/** Best image for a role across a set of entries (largest wins as a resolution proxy). */
export function pickBestByRole(entries: TexImage[], role: TexRole): TexImage | null {
  const candidates = entries.filter((e) => e.role === role);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0];
}

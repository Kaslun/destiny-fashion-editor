/**
 * Resolves the dye colours carried by a shader (or any item that ships a gear
 * `.js` file). The gear file lists `default_dyes[]`, each tagged with a
 * `slot_type_index` (0/1/2/3) and `material_properties` holding the actual
 * albedo tints, emissive tints and roughness remaps.
 *
 * A shader repeats slots 0/1/2 across several art-content groups (weapon vs
 * armor vs ...); we take the first occurrence of each slot as the representative
 * colour set, which is enough for a faithful recolour preview.
 */
import { getGearAsset } from "./gearAsset";
import { getManifest, cdnUrl } from "./manifest";
import { bungieFetchRaw } from "./client";

export interface SlotDye {
  /** linear RGB albedo tints (0..1) */
  primary: [number, number, number];
  secondary: [number, number, number];
  primaryEmissive: [number, number, number];
  secondaryEmissive: [number, number, number];
}

export type GearDyes = Record<number, SlotDye>;

function rgb3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length >= 3
    ? [Number(v[0]), Number(v[1]), Number(v[2])]
    : fallback;
}

/**
 * Fetch + parse the gear `.js` for a hash and return dye colours keyed by slot.
 * Returns {} for items without a gear file (weapons/armor carry none — their
 * look comes from baked textures; only shaders/dyes supply colour).
 */
export async function getGearDyes(hash: number): Promise<GearDyes> {
  const gearAsset = await getGearAsset(hash);
  // The gear `.js` reference lives at the top level of the record (sibling of
  // `content`), not inside a content entry.
  const topGear = (gearAsset?.raw as { gear?: string[] } | undefined)?.gear;
  const gearFile = topGear?.[0] ?? gearAsset?.content?.[0]?.gear?.[0];
  if (!gearFile) return {};

  const manifest = await getManifest();
  const url = cdnUrl(manifest.gearCdn.Gear, gearFile);
  const res = await bungieFetchRaw(url);
  if (!res.ok) return {};

  const data = JSON.parse(await res.text()) as {
    default_dyes?: {
      slot_type_index?: number;
      material_properties?: Record<string, unknown>;
    }[];
  };

  const out: GearDyes = {};
  for (const dye of data.default_dyes ?? []) {
    const slot = dye.slot_type_index ?? 0;
    if (out[slot]) continue; // first group wins
    const mp = dye.material_properties ?? {};
    out[slot] = {
      primary: rgb3(mp.primary_albedo_tint, [1, 1, 1]),
      secondary: rgb3(mp.secondary_albedo_tint, [1, 1, 1]),
      primaryEmissive: rgb3(mp.primary_emissive_tint_color, [0, 0, 0]),
      secondaryEmissive: rgb3(mp.secondary_emissive_tint_color, [0, 0, 0]),
    };
  }
  return out;
}

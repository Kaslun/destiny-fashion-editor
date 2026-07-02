/**
 * Parses an item/shader's gear `.js` file (referenced at the top level of the
 * gear-asset record, served from `mobileGearCDN.Gear`). It carries three things
 * we need:
 *
 *  - `default_dyes[]` — per-slot material properties: albedo tints (the item's
 *    default colours / a shader's colours) AND emissive tint colours.
 *  - `art_content_sets[].arrangement` — which geometry belongs to the base body
 *    arrangement vs. gender/class overrides. We only render the base so the
 *    alternate arrangements don't overlap.
 *
 * Weapons/armor and shaders all use the same format.
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

export interface ItemGear {
  dyes: GearDyes;
  /**
   * Number of geometry entries that make up the base arrangement. Content lists
   * base + override geometries; we render only the first `baseGeometryCount`.
   * null = no arrangement info (render everything).
   */
  baseGeometryCount: number | null;
}

function rgb3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length >= 3
    ? [Number(v[0]), Number(v[1]), Number(v[2])]
    : fallback;
}

function parseDyes(defaultDyes: unknown): GearDyes {
  const out: GearDyes = {};
  for (const dye of (defaultDyes as { slot_type_index?: number; material_properties?: Record<string, unknown> }[]) ?? []) {
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

// Small in-memory cache — loadGearModel resolves gear for the item (arrangement
// + dyes) and often the shader too; avoid re-fetching the same gear file.
const gearCache = new Map<number, ItemGear>();

/** Parse the gear file for a hash: dyes + base-arrangement geometry count. */
export async function getItemGear(hash: number): Promise<ItemGear> {
  const cached = gearCache.get(hash);
  if (cached) return cached;

  const empty: ItemGear = { dyes: {}, baseGeometryCount: null };
  const gearAsset = await getGearAsset(hash);
  const gearFile =
    (gearAsset?.raw as { gear?: string[] } | undefined)?.gear?.[0] ??
    gearAsset?.content?.[0]?.gear?.[0];
  if (!gearFile) {
    gearCache.set(hash, empty);
    return empty;
  }

  const manifest = await getManifest();
  const res = await bungieFetchRaw(cdnUrl(manifest.gearCdn.Gear, gearFile));
  if (!res.ok) {
    gearCache.set(hash, empty);
    return empty;
  }

  const data = JSON.parse(await res.text()) as {
    default_dyes?: unknown;
    art_content_sets?: {
      arrangement?: {
        gear_set?: {
          base_art_arrangement?: { geometry_hashes?: string[] };
        };
      };
    }[];
  };

  const base =
    data.art_content_sets?.[0]?.arrangement?.gear_set?.base_art_arrangement;
  const result: ItemGear = {
    dyes: parseDyes(data.default_dyes),
    baseGeometryCount: base?.geometry_hashes?.length ?? null,
  };
  gearCache.set(hash, result);
  return result;
}

/** Convenience: just the per-slot dye colours for a hash. */
export async function getGearDyes(hash: number): Promise<GearDyes> {
  return (await getItemGear(hash)).dyes;
}

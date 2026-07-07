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
  /**
   * Worn albedo tint — the colour a surface takes in its worn/scratched areas,
   * blended in by the gearstack wear mask (alpha channel). Falls back to the
   * secondary tint when the dye doesn't ship one.
   */
  worn: [number, number, number];
  primaryEmissive: [number, number, number];
  secondaryEmissive: [number, number, number];
  /** entry names of the tiled per-slot detail maps (inside the item's texture containers) */
  detailDiffuse: string | null;
  detailNormal: string | null;
  /** [scaleX, scaleY, offsetX, offsetY] tiling transform for the detail maps */
  detailTransform: [number, number, number, number];
  /** Bungie's authoritative per-slot material flag: true = fabric/soft goods. */
  cloth: boolean;
  /** raw primary_material_params vec4 (channel meanings partly undocumented). */
  materialParams: [number, number, number, number];
  /** primary_roughness_remap[3] output max — soft gloss hint (low = glossy). */
  roughnessRemapMax: number;
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
  /** debug: raw default_dyes array (to inspect slot_type_index / change-color mapping) */
  rawDefaultDyes?: unknown;
}

function rgb3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length >= 3
    ? [Number(v[0]), Number(v[1]), Number(v[2])]
    : fallback;
}

function xform4(v: unknown): [number, number, number, number] {
  return Array.isArray(v) && v.length >= 4
    ? [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])]
    : [1, 1, 0, 0];
}

function parseDyes(defaultDyes: unknown): GearDyes {
  const out: GearDyes = {};
  const dyes = (defaultDyes as {
    slot_type_index?: number;
    cloth?: boolean;
    material_properties?: Record<string, unknown>;
    textures?: Record<string, { name?: string } | undefined>;
  }[]) ?? [];
  for (const dye of dyes) {
    const slot = dye.slot_type_index ?? 0;
    if (out[slot]) continue; // first group wins
    const mp = dye.material_properties ?? {};
    const tx = dye.textures ?? {};
    out[slot] = {
      primary: rgb3(mp.primary_albedo_tint, [1, 1, 1]),
      secondary: rgb3(mp.secondary_albedo_tint, [1, 1, 1]),
      // Worn tint: the colour scratched/worn regions take (gearstack wear mask
      // blends toward it). Bungie ships `worn_albedo_tint`; when absent, wear
      // just darkens toward the secondary tint, so fall back to that.
      worn: rgb3(
        mp.worn_albedo_tint,
        rgb3(mp.secondary_albedo_tint, [1, 1, 1]),
      ),
      // Bungie ships emissive as `*_emissive_tint_color_and_intensity_bias`
      // (vec4 [r,g,b,i]); older/other dumps use `*_emissive_tint_color`.
      // rgb3 takes the first three components of whichever exists.
      primaryEmissive: rgb3(
        mp.primary_emissive_tint_color_and_intensity_bias ??
          mp.primary_emissive_tint_color,
        [0, 0, 0],
      ),
      secondaryEmissive: rgb3(
        mp.secondary_emissive_tint_color_and_intensity_bias ??
          mp.secondary_emissive_tint_color,
        [0, 0, 0],
      ),
      // Detail-map entry names live in the dye's texture container. The key
      // varies across dumps (`detail_diffuse`/`detail_normal` in current gear
      // files, `diffuse`/`normal` in some). Check both.
      detailDiffuse:
        tx.detail_diffuse?.name ?? tx.diffuse?.name ?? null,
      detailNormal:
        tx.detail_normal?.name ?? tx.normal?.name ?? null,
      detailTransform: xform4(mp.detail_diffuse_transform),
      cloth: dye.cloth === true,
      materialParams: xform4(mp.primary_material_params),
      roughnessRemapMax: (() => {
        const rr = mp.primary_roughness_remap;
        return Array.isArray(rr) && rr.length >= 4 ? Number(rr[3]) : 0;
      })(),
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

  // The gear `.js` filename can sit in a few places depending on the asset
  // shape. Check all known locations rather than only raw.gear[0]:
  //   - raw.gear[]            (top-level, common)
  //   - content[].gear[]      (per-content-entry)
  // Some assets list multiple gear files; the dye/arrangement data is in the
  // first that exists.
  const raw = gearAsset?.raw as
    | { gear?: string[]; content?: { gear?: string[] }[] }
    | undefined;
  const content = gearAsset?.content as { gear?: string[] }[] | undefined;
  const gearFile =
    raw?.gear?.[0] ??
    raw?.content?.[0]?.gear?.[0] ??
    content?.[0]?.gear?.[0] ??
    content?.find((c) => c?.gear?.length)?.gear?.[0];

  if (!gearFile) {
    // No gear file anywhere on this asset. Cache and return empty — but keep
    // the raw asset on the result so the debug endpoint can show WHY (the
    // caller can inspect what shape getGearAsset actually returned).
    const noGear: ItemGear = {
      ...empty,
      rawDefaultDyes: { _noGearFile: true, asset: gearAsset ?? null },
    };
    gearCache.set(hash, noGear);
    return noGear;
  }

  const manifest = await getManifest();
  const res = await bungieFetchRaw(cdnUrl(manifest.gearCdn.Gear, gearFile));
  if (!res.ok) {
    const failed: ItemGear = {
      ...empty,
      rawDefaultDyes: { _fetchFailed: true, status: res.status, gearFile },
    };
    gearCache.set(hash, failed);
    return failed;
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
  const dyes = parseDyes(data.default_dyes);

  // If the gear file loaded but carried no default_dyes, this is an item whose
  // default appearance is defined by a shader plug (common for armor). The
  // item's own gear file has geometry but no colours — the dyes live in the
  // item definition's translationBlock.defaultDyes, which point at a shader's
  // gear file. Resolving that requires the item def + a shader-hash -> gear-file
  // lookup (see Destiny-Collada-Generator generatePresets: translationBlock
  // .defaultDyes -> shader gear .js). NOT done here because it needs the
  // manifest item definition, which this function doesn't fetch.
  //
  // TODO(shader-default-dyes): when Object.keys(dyes).length === 0, fetch
  //   DestinyInventoryItemDefinition[hash].translationBlock.defaultDyes, resolve
  //   each channel's dye hash to its shader gear file, and parseDyes THAT.
  // Until then such items render with the name-keyword classifier's fallback
  // (dielectric), which is correct-ish for cloth and avoids the metallic bug.

  const result: ItemGear = {
    dyes,
    baseGeometryCount: base?.geometry_hashes?.length ?? null,
    // debug: distinguish "gear file had no dyes" from "parse produced none".
    rawDefaultDyes:
      data.default_dyes ?? { _noDefaultDyesInGearFile: true, gearFile },
  };
  gearCache.set(hash, result);
  return result;
}

/** Convenience: just the per-slot dye colours for a hash. */
export async function getGearDyes(hash: number): Promise<GearDyes> {
  return (await getItemGear(hash)).dyes;
}
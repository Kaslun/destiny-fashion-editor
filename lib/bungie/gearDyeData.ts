/**
 * Parses an item/shader's gear `.js` file (referenced at the top level of the
 * gear-asset record, served from `mobileGearCDN.Gear`). It carries three things
 * we need:
 *
 *  - `default_dyes[]` — per-slot material properties (Bungie's Destiny 2 PBR
 *    dye schema: albedo tints, roughness/wear remaps, per-tint metalness,
 *    fuzz, emissive, SSS). Parsed in FULL for both the primary and secondary
 *    tint of every slot — the renderer picks per stage part.
 *  - `locked_dyes[]` — same schema; always render regardless of an applied
 *    shader (exotics).
 *  - `art_content_sets[].arrangement` — which geometry belongs to the base
 *    body arrangement vs. gender/class overrides.
 *
 * Field semantics established empirically against an 8-helmet corpus
 * (cat-eye 1435559164, first ascent 2468561950, holdfast 3097544525,
 * iron intent 144007143, sunlit hood 2013981053, veiled tithes 523074950,
 * cover of the exile 571925067, nighthawk 3960926756):
 *
 *  - `*_material_params[3]` is the tint's METALNESS. It tracks material type
 *    across the whole corpus (all metal slots 0.85–1, every cloth/leather/
 *    rubber slot 0) and splits within a slot exactly where the art does:
 *    Sunlit Hood slot 0 is black paint (primary, 0) with gold trim
 *    (secondary, 0.85). `*_worn_material_parameters[3]` is the worn-state
 *    metalness (e.g. paint scratching through to bare metal).
 *  - `*_material_params[0]` gates how strongly the tiled detail maps blend
 *    over the base (0 on Nighthawk's gold plate, 1 on cloth).
 *  - `*_material_advanced_params[0]` is a material-type id (-1, 5, 25, 35,
 *    105…), `[1]` is the FUZZ amount — nonzero on exactly the cloth-flagged
 *    slots in the corpus (0.1–0.62). Fuzz is Bungie's inverted-GGX cloth
 *    lobe (GDC 2018); we approximate it with sheen.
 *  - `*_roughness_remap` / `*_wear_remap` / `*_worn_roughness_remap` are vec4
 *    remaps of the gearstack smoothness/wear channels. The exact runtime
 *    formula is not public — outputs can leave [0,1] (e.g. [-1, 1.85]),
 *    consistent with Bungie's signed smoothness domain where negative
 *    smoothness = fuzz. Shipped raw; the client shader owns interpretation.
 */
import { getGearAsset } from "./gearAsset";
import { getManifest, cdnUrl } from "./manifest";
import { bungieFetchRaw } from "./client";

/** One tint (primary or secondary) of a dye slot — Bungie's full PBR set. */
export interface DyeTint {
  /** linear RGB albedo tint (0..1) */
  albedo: [number, number, number];
  /** albedo the surface takes in worn/scratched areas (gearstack wear mask) */
  wornAlbedo: [number, number, number];
  /** material_params[3] — 0 dielectric .. 1 metal */
  metalness: number;
  /** worn_material_parameters[3] — metalness of the worn state */
  wornMetalness: number;
  /** material_params[0] — detail-map blend strength 0..1 */
  detailBlend: number;
  /** material_advanced_params[1] — fuzz (cloth) amount 0..1 */
  fuzz: number;
  /** material_advanced_params[0] — engine material-type id (-1 = default) */
  materialTypeId: number;
  /** roughness_remap vec4 applied to the gearstack smoothness channel */
  roughnessRemap: [number, number, number, number];
  /** worn_roughness_remap vec4 — smoothness remap of the worn state */
  wornRoughnessRemap: [number, number, number, number];
  /** wear_remap vec4 applied to the gearstack wear signal */
  wearRemap: [number, number, number, number];
  /** emissive_tint_color_and_intensity_bias rgb */
  emissive: [number, number, number];
  /** emissive_tint_color_and_intensity_bias[3] */
  emissiveIntensity: number;
  /** subsurface_scattering_strength_and_emissive[0] (0 = none, the norm) */
  sss: number;
}

export interface SlotDye {
  /** Bungie's authoritative per-slot material flag: true = fabric/soft goods. */
  cloth: boolean;
  /** entry names of the tiled per-slot detail maps (inside the item's texture containers) */
  detailDiffuse: string | null;
  detailNormal: string | null;
  /** [scaleX, scaleY, offsetX, offsetY] tiling transform for the detail diffuse */
  detailDiffuseTransform: [number, number, number, number];
  /** separate tiling transform for the detail normal (often differs) */
  detailNormalTransform: [number, number, number, number];
  primary: DyeTint;
  secondary: DyeTint;
}

export type GearDyes = Record<number, SlotDye>;

export interface ItemGear {
  dyes: GearDyes;
  /** locked_dyes — always render regardless of an applied shader (exotics). */
  lockedDyes: GearDyes;
  /**
   * Number of geometry entries that make up the base arrangement. Content lists
   * base + override geometries; we render only the first `baseGeometryCount`.
   * null = no arrangement info (render everything).
   */
  baseGeometryCount: number | null;
  /** debug: raw default_dyes array (to inspect slot_type_index / change-color mapping) */
  rawDefaultDyes?: unknown;
  /** debug: the complete parsed gear .js payload (only kept in memory cache). */
  rawGearFile?: unknown;
}

function rgb3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length >= 3
    ? [Number(v[0]), Number(v[1]), Number(v[2])]
    : fallback;
}

function vec4(
  v: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  return Array.isArray(v) && v.length >= 4
    ? [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])]
    : fallback;
}

function num(v: unknown, fallback: number): number {
  const n = Array.isArray(v) ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** No-op remap: full input range mapped straight through. */
const IDENTITY_REMAP: [number, number, number, number] = [0, 1, 0, 1];

function parseTint(
  mp: Record<string, unknown>,
  prefix: "primary" | "secondary",
): DyeTint {
  const p = (name: string) => mp[`${prefix}_${name}`];
  const albedo = rgb3(p("albedo_tint"), [1, 1, 1]);
  const materialParams = vec4(p("material_params"), [0, 0, 0, 0]);
  const wornParams = vec4(p("worn_material_parameters"), materialParams);
  const advanced = vec4(p("material_advanced_params"), [-1, 0, 0, 0]);
  const emissive = vec4(
    p("emissive_tint_color_and_intensity_bias") ?? p("emissive_tint_color"),
    [0, 0, 0, 0],
  );
  const sssVec = p("subsurface_scattering_strength_and_emissive");
  return {
    albedo,
    wornAlbedo: rgb3(p("worn_albedo_tint"), albedo),
    metalness: Math.max(0, Math.min(1, materialParams[3])),
    wornMetalness: Math.max(0, Math.min(1, wornParams[3])),
    detailBlend: Math.max(0, Math.min(1, materialParams[0])),
    fuzz: Math.max(0, Math.min(1, advanced[1])),
    materialTypeId: advanced[0],
    roughnessRemap: vec4(p("roughness_remap"), IDENTITY_REMAP),
    wornRoughnessRemap: vec4(
      p("worn_roughness_remap"),
      vec4(p("roughness_remap"), IDENTITY_REMAP),
    ),
    wearRemap: vec4(p("wear_remap"), IDENTITY_REMAP),
    emissive: [emissive[0], emissive[1], emissive[2]],
    emissiveIntensity: num(emissive[3], 0),
    sss: Array.isArray(sssVec) && sssVec.length > 0 ? Number(sssVec[0]) : 0,
  };
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
    const detailDiffuseTransform = vec4(mp.detail_diffuse_transform, [1, 1, 0, 0]);
    out[slot] = {
      cloth: dye.cloth === true,
      // Detail-map entry names live in the dye's texture container. The key
      // varies across dumps (`detail_diffuse`/`detail_normal` in current gear
      // files, `diffuse`/`normal` in some). Check both.
      detailDiffuse: tx.detail_diffuse?.name ?? tx.diffuse?.name ?? null,
      detailNormal: tx.detail_normal?.name ?? tx.normal?.name ?? null,
      detailDiffuseTransform,
      detailNormalTransform: vec4(mp.detail_normal_transform, detailDiffuseTransform),
      primary: parseTint(mp, "primary"),
      secondary: parseTint(mp, "secondary"),
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

  const empty: ItemGear = { dyes: {}, lockedDyes: {}, baseGeometryCount: null };
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
    locked_dyes?: unknown;
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
  // Locked dyes always render regardless of an applied shader (exotics that
  // ignore shaders on certain regions). Same schema as default_dyes.
  const lockedDyes = parseDyes(data.locked_dyes);

  // If the gear file loaded but carried no default_dyes, this is an item whose
  // default appearance is defined by a shader plug (common for armor). The
  // item's own gear file has geometry but no colours — the dyes live in the
  // item definition's translationBlock.defaultDyes, which point at a shader's
  // gear file. Resolving that requires the item def + a shader-hash -> gear-file
  // lookup. NOT done here because it needs the manifest item definition, which
  // this function doesn't fetch.
  //
  // TODO(shader-default-dyes): when Object.keys(dyes).length === 0, fetch
  //   DestinyInventoryItemDefinition[hash].translationBlock.defaultDyes, resolve
  //   each channel's dye hash to its shader gear file, and parseDyes THAT.

  const result: ItemGear = {
    dyes,
    lockedDyes,
    baseGeometryCount: base?.geometry_hashes?.length ?? null,
    // debug: distinguish "gear file had no dyes" from "parse produced none".
    rawDefaultDyes:
      data.default_dyes ?? { _noDefaultDyesInGearFile: true, gearFile },
    rawGearFile: data,
  };
  gearCache.set(hash, result);
  return result;
}

/** Convenience: just the per-slot dye colours for a hash. */
export async function getGearDyes(hash: number): Promise<GearDyes> {
  return (await getItemGear(hash)).dyes;
}

/** Convenience: just the locked-dye slots for a hash (usually empty). */
export async function getLockedDyes(hash: number): Promise<GearDyes> {
  return (await getItemGear(hash)).lockedDyes;
}

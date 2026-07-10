/**
 * Client-side gear dye model.
 *
 * A rendered item has up to 4 dye slots (0/1/2 recolourable, 3 = investment
 * decal). Each slot carries a PRIMARY and a SECONDARY tint — full independent
 * PBR parameter sets (albedo, worn albedo, metalness, remaps, fuzz, emissive,
 * SSS) straight from Bungie's Destiny 2 dye schema — plus tiled DETAIL maps
 * (micro-surface diffuse/normal, e.g. worn metal or fabric weave). Which tint
 * a surface uses is decided per stage part by the low bit of
 * `gear_dye_change_color_index` (see gearMaterial.ts).
 *
 * Data comes from /api/dyes (lib/bungie/gearDyeData.ts); detail map names are
 * resolved to THREE textures by the loader.
 */
import * as THREE from "three";

export type Vec4 = [number, number, number, number];

/** One tint (primary or secondary) of a dye slot. */
export interface DyeTint {
  albedo: THREE.Color;
  /** worn/scratched-area tint, blended in by the gearstack wear mask (alpha) */
  wornAlbedo: THREE.Color;
  /** material_params[3] — 0 dielectric .. 1 metal (real data, not a heuristic) */
  metalness: number;
  /** worn_material_parameters[3] — metalness of the worn state */
  wornMetalness: number;
  /** material_params[0] — how strongly the tiled detail maps blend over the base */
  detailBlend: number;
  /** material_advanced_params[1] — Bungie's fuzz (cloth) amount, mapped to sheen */
  fuzz: number;
  /** roughness_remap vec4 for the gearstack smoothness channel */
  roughnessRemap: Vec4;
  /** worn_roughness_remap vec4 (worn-state smoothness) */
  wornRoughnessRemap: Vec4;
  /** wear_remap vec4 for the gearstack wear signal */
  wearRemap: Vec4;
  emissive: THREE.Color;
  emissiveIntensity: number;
  /** subsurface scattering strength (0 = none, the common case) */
  sss: number;
}

export interface DyeSlot {
  /** Bungie's authoritative per-slot fabric flag (default_dyes[].cloth). */
  cloth: boolean;
  /** entry names of tiled detail maps (resolved to textures by the loader) */
  detailDiffuseName: string | null;
  detailNormalName: string | null;
  /** [scaleX, scaleY, offsetX, offsetY] detail tiling transforms */
  detailDiffuseTransform: Vec4;
  detailNormalTransform: Vec4;
  primary: DyeTint;
  secondary: DyeTint;
  /** filled in by the loader from the names above */
  detailDiffuse?: THREE.Texture;
  detailNormal?: THREE.Texture;
}

export type DyeSet = Record<number, DyeSlot>;

const IDENTITY_REMAP: Vec4 = [0, 1, 0, 1];

function neutralTint(): DyeTint {
  return {
    albedo: new THREE.Color(1, 1, 1),
    wornAlbedo: new THREE.Color(1, 1, 1),
    metalness: 0.1,
    wornMetalness: 0.1,
    detailBlend: 0,
    fuzz: 0,
    roughnessRemap: IDENTITY_REMAP,
    wornRoughnessRemap: IDENTITY_REMAP,
    wearRemap: [0, 0, 0, 0], // no wear
    emissive: new THREE.Color(0, 0, 0),
    emissiveIntensity: 0,
    sss: 0,
  };
}

/** Neutral gunmetal fallback for unresolved slots. */
export function neutralSlot(): DyeSlot {
  return {
    cloth: false,
    detailDiffuseName: null,
    detailNormalName: null,
    detailDiffuseTransform: [1, 1, 0, 0],
    detailNormalTransform: [1, 1, 0, 0],
    primary: neutralTint(),
    secondary: neutralTint(),
  };
}

/** Slot data for a given dye slot, or neutral if unresolved. */
export function dyeForSlot(set: DyeSet, slot: number): DyeSlot {
  return set[slot] ?? neutralSlot();
}

/**
 * All slots present in the set, ranked softest to hardest: cloth-flagged
 * always first, remaining slots by ascending primary metalness (so e.g.
 * leather sits below metal). Not limited to 0-2 — an item defines however
 * many slots its gear file ships (Bungie's recolourable set is 3 slots × 2
 * tints, but the data drives it). Used by the POC materials panel and the
 * threshold band split.
 */
export function rankSlotsSoftToHard(dyes: DyeSet): number[] {
  const existingSlots = Object.keys(dyes)
    .map(Number)
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => a - b);
  return [...existingSlots].sort((a, b) => {
    const da = dyeForSlot(dyes, a);
    const db = dyeForSlot(dyes, b);
    const rankA = da.cloth ? -1 : da.primary.metalness;
    const rankB = db.cloth ? -1 : db.primary.metalness;
    return rankB - rankA;
  });
}

/** Wire shape of one tint in the /api/dyes response (lib/bungie/gearDyeData). */
interface ApiTint {
  albedo?: number[];
  wornAlbedo?: number[];
  metalness?: number;
  wornMetalness?: number;
  detailBlend?: number;
  fuzz?: number;
  roughnessRemap?: number[];
  wornRoughnessRemap?: number[];
  wearRemap?: number[];
  emissive?: number[];
  emissiveIntensity?: number;
  sss?: number;
}

interface ApiSlotDye {
  cloth?: boolean;
  detailDiffuse?: string | null;
  detailNormal?: string | null;
  detailDiffuseTransform?: number[];
  detailNormalTransform?: number[];
  primary?: ApiTint;
  secondary?: ApiTint;
}

function color3(v: number[] | undefined, fallback: THREE.Color): THREE.Color {
  // Tints are linear multipliers applied to the (linear) diffuse, so Color
  // components are set directly without sRGB conversion.
  return Array.isArray(v) && v.length >= 3
    ? new THREE.Color(v[0], v[1], v[2])
    : fallback.clone();
}

function tuple4(v: number[] | undefined, fallback: Vec4): Vec4 {
  return Array.isArray(v) && v.length >= 4 ? [v[0], v[1], v[2], v[3]] : fallback;
}

function tintFromApi(t: ApiTint | undefined): DyeTint {
  const base = neutralTint();
  if (!t) return base;
  const albedo = color3(t.albedo, base.albedo);
  return {
    albedo,
    wornAlbedo: color3(t.wornAlbedo, albedo),
    metalness: typeof t.metalness === "number" ? t.metalness : base.metalness,
    wornMetalness:
      typeof t.wornMetalness === "number" ? t.wornMetalness : base.wornMetalness,
    detailBlend: typeof t.detailBlend === "number" ? t.detailBlend : 0,
    fuzz: typeof t.fuzz === "number" ? t.fuzz : 0,
    roughnessRemap: tuple4(t.roughnessRemap, IDENTITY_REMAP),
    wornRoughnessRemap: tuple4(
      t.wornRoughnessRemap,
      tuple4(t.roughnessRemap, IDENTITY_REMAP),
    ),
    wearRemap: tuple4(t.wearRemap, [0, 0, 0, 0]),
    emissive: color3(t.emissive, new THREE.Color(0, 0, 0)),
    emissiveIntensity:
      typeof t.emissiveIntensity === "number" ? t.emissiveIntensity : 0,
    sss: typeof t.sss === "number" ? t.sss : 0,
  };
}

/** Build a DyeSet from the /api/dyes response. */
export function dyeSetFromGearDyes(slots: Record<string, ApiSlotDye>): DyeSet {
  const set: DyeSet = {};
  for (const [key, d] of Object.entries(slots)) {
    const diffuseTransform = tuple4(d.detailDiffuseTransform, [1, 1, 0, 0]);
    set[Number(key)] = {
      cloth: d.cloth === true,
      detailDiffuseName: d.detailDiffuse ?? null,
      detailNormalName: d.detailNormal ?? null,
      detailDiffuseTransform: diffuseTransform,
      detailNormalTransform: tuple4(d.detailNormalTransform, diffuseTransform),
      primary: tintFromApi(d.primary),
      secondary: tintFromApi(d.secondary),
    };
  }
  return set;
}

/**
 * Merge default/custom/locked dye sets per Bungie's documented resolution
 * order: defaultDyes -> customDyes -> lockedDyes, with locked always winning
 * (exotics that ignore an applied shader on certain slots). A slot only
 * present in one set falls through to the others; empty sets are safe.
 */
export function resolveDyeSet(
  defaultDyes: DyeSet,
  customDyes: DyeSet,
  lockedDyes: DyeSet,
): DyeSet {
  return { ...defaultDyes, ...customDyes, ...lockedDyes };
}

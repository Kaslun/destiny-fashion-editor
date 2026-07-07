/**
 * Gear dye colours + per-slot detail maps.
 *
 * A rendered item has up to 4 dye slots. Each slot gets primary/secondary
 * albedo tints, an emissive tint, and tiled DETAIL maps (micro-surface
 * diffuse/normal, e.g. worn metal or fabric weave) resolved from the item's or
 * shader's gear `.js` (see lib/bungie/gearDyeData.ts + /api/dyes). Detail map
 * names are resolved to THREE textures by the loader; unresolved slots fall
 * back to a neutral gunmetal.
 */
import * as THREE from "three";

export interface DyeColors {
  primary: THREE.Color;
  secondary: THREE.Color;
  /** roughness hint 0..1 */
  roughness: number;
  /** metalness hint 0..1 */
  metalness: number;
  /** primary/secondary emissive (glow) tints, selected like the albedo tints */
  emissive: THREE.Color;
  secondaryEmissive: THREE.Color;
  /** entry names of tiled detail maps (resolved to textures by the loader) */
  detailDiffuseName: string | null;
  detailNormalName: string | null;
  /** [scaleX, scaleY, offsetX, offsetY] detail tiling transform */
  detailTransform: [number, number, number, number];
  /** Bungie's authoritative per-slot fabric flag (default_dyes[].cloth). */
  cloth: boolean;
  /**
   * Per-slot detail-map blend strength, from material_params[0]. 0 = no detail
   * contribution (e.g. Nighthawk's gold faceplate), 1 = full (cloth). Gates how
   * strongly the tiled detail diffuse/normal modulate the base surface.
   */
  detailStrength: number;
  /** filled in by the loader from the names above */
  detailDiffuse?: THREE.Texture;
  detailNormal?: THREE.Texture;
}

export type DyeSet = Record<number, DyeColors>;

const NEUTRAL: DyeColors = {
  primary: new THREE.Color(0xffffff),
  secondary: new THREE.Color(0xffffff),
  roughness: 0.8,
  metalness: 0.1,
  emissive: new THREE.Color(0, 0, 0),
  secondaryEmissive: new THREE.Color(0, 0, 0),
  detailDiffuseName: null,
  detailNormalName: null,
  detailTransform: [1, 1, 0, 0],
  cloth: false,
  detailStrength: 0,
};

/** Colours for a given dye slot, or neutral if unresolved. */
export function dyeForSlot(set: DyeSet, slot: number): DyeColors {
  return set[slot] ?? NEUTRAL;
}

interface ApiSlotDye {
  primary: number[];
  secondary: number[];
  primaryEmissive?: number[];
  secondaryEmissive?: number[];
  detailDiffuse?: string | null;
  detailNormal?: string | null;
  detailTransform?: number[];
  /** Bungie's authoritative per-slot fabric flag (from default_dyes[].cloth). */
  cloth?: boolean;
  /** raw primary_material_params vec4; channel 0 used as detail-blend strength. */
  materialParams?: number[];
  /** primary_roughness_remap[3] (output max): low = glossy/metal, high = matte. */
  roughnessRemapMax?: number;
}

/**
 * Per-slot metalness/roughness, derived empirically from ~15 items' default_dyes.
 *
 * What the data showed (and did NOT show):
 *  - Bungie ships NO clean per-slot metalness scalar. material_params is a
 *    wear/blend control set (Monochromatic, a uniform-neutral shader, has it all
 *    zeroed), and material_advanced_params[0] is a shader MATERIAL-TYPE id (-1,
 *    23, 25, 35, 36, 40, 49, 51, 99...), not a value we can interpret directly.
 *  - The reliable signals are: the `cloth` boolean (authoritative fabric flag),
 *    the detail-map NAME (clusters cleanly by material across the corpus), and
 *    roughness_remap[3] (output max) as a soft gloss hint — metal slots land low
 *    (gold 0.15, brushed/carbon 0.16-0.23), matte slots high.
 *
 * So: metalness comes from the name (only reliable metal signal); roughness
 * starts from the material class and is refined by roughnessRemapMax when present.
 */
export function pbrFromDetail(
  diffuse?: string | null,
  normal?: string | null,
  cloth?: boolean,
  roughnessRemapMax?: number,
): { metalness: number; roughness: number } {
  const dif = (diffuse ?? "").toLowerCase();
  const nrm = (normal ?? "").toLowerCase();

  // Refine a base roughness with the remap-max hint when it's present and sane.
  // Blend rather than replace: the remap is a curve over a texture channel we
  // may not have, so it's a nudge, not ground truth.
  const refine = (base: number): number => {
    if (typeof roughnessRemapMax === "number" && roughnessRemapMax > 0 && roughnessRemapMax <= 1) {
      return Math.max(0.05, Math.min(1, base * 0.5 + roughnessRemapMax * 0.5));
    }
    return base;
  };

  // Authoritative: Bungie flagged this slot as fabric. Always dielectric + rough.
  if (cloth === true) {
    return { metalness: 0.0, roughness: refine(0.85) };
  }

  // Metal family (from the corpus: metal, metal_brushed, metal_cubes,
  // carbon_fiber, battleworn_metal, armor_galvanized, plus classic keywords).
  // Decided on the diffuse name — the albedo author's material intent.
  if (/\bmetal\b|metal_brushed|metal_cubes|carbon_fiber|battleworn_metal|galvaniz|chrome|steel|iron|\bgold\b|brass|bronze|silver|grunge0/.test(dif)) {
    // Metal is glossy; trust a low remap-max strongly here.
    return { metalness: 1.0, roughness: refine(0.3) };
  }

  // Leather (dielectric, mid roughness) — corpus: leather, leather2, leather_worn.
  if (/leather|suede|hide/.test(dif)) {
    return { metalness: 0.0, roughness: refine(0.6) };
  }

  // Rubber / tech (dielectric, matte) — corpus: rubber.
  if (/rubber|vinyl|tech/.test(dif)) {
    return { metalness: 0.0, roughness: refine(0.8) };
  }

  // Fabric-ish names as a secondary cloth signal when the flag is absent
  // (weave, felt, cotton_fabric, fabric01, gore-tex).
  const soft = `${dif} ${nrm}`;
  if (/weave|felt|cloth|fabric|cotton|linen|wool|canvas|knit|silk|denim|gore-tex/.test(soft)) {
    return { metalness: 0.0, roughness: refine(0.85) };
  }

  // Default: painted / ceramic / worn armor plate / generic detail
  // (armor_battleworn, crust, hive_pattern, grime, noise, speckle, edz_common).
  return { metalness: 0.0, roughness: refine(0.6) };
}

/**
 * Build a DyeSet from the /api/dyes response. Tints are linear multipliers
 * applied to the (linear) diffuse, so Color components are set directly
 * without sRGB conversion.
 */
export function dyeSetFromGearDyes(slots: Record<string, ApiSlotDye>): DyeSet {
  const set: DyeSet = {};
  for (const [key, d] of Object.entries(slots)) {
    const t = d.detailTransform;
    const pbr = pbrFromDetail(d.detailDiffuse, d.detailNormal, d.cloth, d.roughnessRemapMax);
    set[Number(key)] = {
      primary: new THREE.Color().fromArray(d.primary),
      secondary: new THREE.Color().fromArray(d.secondary),
      roughness: pbr.roughness,
      metalness: pbr.metalness,
      emissive: d.primaryEmissive
        ? new THREE.Color().fromArray(d.primaryEmissive)
        : new THREE.Color(0, 0, 0),
      secondaryEmissive: d.secondaryEmissive
        ? new THREE.Color().fromArray(d.secondaryEmissive)
        : new THREE.Color(0, 0, 0),
      detailDiffuseName: d.detailDiffuse ?? null,
      detailNormalName: d.detailNormal ?? null,
      detailTransform:
        Array.isArray(t) && t.length >= 4
          ? [t[0], t[1], t[2], t[3]]
          : [1, 1, 0, 0],
      cloth: d.cloth === true,
      detailStrength:
        Array.isArray(d.materialParams) && d.materialParams.length > 0
          ? Math.max(0, Math.min(1, Number(d.materialParams[0])))
          : d.cloth === true
            ? 1
            : 0,
    };
  }
  return set;
}
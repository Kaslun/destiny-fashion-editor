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
}

/**
 * Per-slot metalness/roughness. Bungie ships an authoritative `cloth` boolean
 * per dye slot in default_dyes — when set, it's the definitive signal (fabric =
 * dielectric, high roughness) and overrides everything. Bungie does NOT ship a
 * clean metalness scalar (material_params exists but its channel meanings are
 * only partly documented and don't cleanly separate metal from cloth), so for
 * NON-cloth slots we fall back to classifying metal vs painted-plate from the
 * detail-map NAME: metal diffuse (`metal_grunge00`) → metal, else dielectric.
 * The name check trusts the diffuse (albedo author's intent); the normal map is
 * reused across material types and is only a weak hint.
 */
export function pbrFromDetail(
  diffuse?: string | null,
  normal?: string | null,
  cloth?: boolean,
): { metalness: number; roughness: number } {
  // Authoritative: Bungie flagged this slot as fabric.
  if (cloth === true) {
    return { metalness: 0.0, roughness: 0.85 };
  }

  const dif = (diffuse ?? "").toLowerCase();
  const nrm = (normal ?? "").toLowerCase();

  // Metal: decided on the diffuse name only. `grunge0` catches Bungie's
  // `metal_grunge00` family; `\bmetal\b` is the primary anchor.
  if (/\bmetal\b|chrome|steel|iron|\bgold\b|brass|bronze|silver|grunge0/.test(dif)) {
    return { metalness: 1.0, roughness: 0.4 };
  }

  // Non-cloth fabric-ish names (leather, etc.) as a secondary signal.
  const soft = `${dif} ${nrm}`;
  if (/weave|felt|cloth|fabric|leather|linen|wool|canvas|knit|silk|denim|hide|suede/.test(soft)) {
    return { metalness: 0.0, roughness: 0.85 };
  }

  // Default: painted / ceramic / worn armor plate — dielectric, mid roughness.
  return { metalness: 0.0, roughness: 0.6 };
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
    const pbr = pbrFromDetail(d.detailDiffuse, d.detailNormal, d.cloth);
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
    };
  }
  return set;
}
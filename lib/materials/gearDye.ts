/**
 * Gear dye colours.
 *
 * A rendered item has up to 4 dye slots. When a shader is applied, each slot
 * gets primary/secondary albedo tints resolved from the shader's gear `.js`
 * (see lib/bungie/gearDyeData.ts + /api/dyes). Without a shader the item shows
 * its baked textures, and any unresolved slot falls back to a neutral gunmetal.
 */
import * as THREE from "three";

export interface DyeColors {
  primary: THREE.Color;
  secondary: THREE.Color;
  /** roughness hint 0..1 */
  roughness: number;
  /** metalness hint 0..1 */
  metalness: number;
  /** emissive tint (linear RGB); applied where the gearstack emissive mask is set */
  emissive: THREE.Color;
}

export type DyeSet = Record<number, DyeColors>;

const NEUTRAL: DyeColors = {
  primary: new THREE.Color(0x8a8f96),
  secondary: new THREE.Color(0x4a4e54),
  roughness: 0.6,
  metalness: 0.4,
  emissive: new THREE.Color(0, 0, 0),
};

/** Colours for a given dye slot, or neutral if unresolved. */
export function dyeForSlot(set: DyeSet, slot: number): DyeColors {
  return set[slot] ?? NEUTRAL;
}

/**
 * Build a DyeSet from the /api/dyes response (a shader's per-slot albedo tints).
 * Tints are linear multipliers applied to the (linear) diffuse, so we set the
 * Color components directly without sRGB conversion.
 */
export function dyeSetFromGearDyes(
  slots: Record<
    string,
    { primary: number[]; secondary: number[]; primaryEmissive?: number[] }
  >,
): DyeSet {
  const set: DyeSet = {};
  for (const [key, d] of Object.entries(slots)) {
    set[Number(key)] = {
      primary: new THREE.Color().fromArray(d.primary),
      secondary: new THREE.Color().fromArray(d.secondary),
      roughness: 0.5,
      metalness: 0.5,
      emissive: d.primaryEmissive
        ? new THREE.Color().fromArray(d.primaryEmissive)
        : new THREE.Color(0, 0, 0),
    };
  }
  return set;
}

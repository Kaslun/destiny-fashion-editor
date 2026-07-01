/**
 * Gear dye resolution.
 *
 * A rendered item has up to 4 dye slots. Each dye carries material properties
 * (primary/secondary albedo tints, wear, roughness). The applied colours are
 * resolved in priority order:
 *
 *   1. locked_dyes   — baked into the item, cannot be overridden
 *   2. custom_dyes    — from an applied shader/ornament
 *   3. default_dyes   — the item's fallback look
 *
 * D2 mobile stores these as `investment_dyes` / dye records whose exact colour
 * fields Bungie only partially documented. We read RGBA arrays where present
 * (`primary_color`, `secondary_color`, `*AlbedoTint`) and fall back to a neutral
 * gunmetal so a mesh always has a sensible material even before dyes resolve.
 */
import * as THREE from "three";

export interface DyeColors {
  primary: THREE.Color;
  secondary: THREE.Color;
  /** roughness hint 0..1 if the dye specifies one */
  roughness: number;
  /** metalness hint 0..1 if the dye specifies one */
  metalness: number;
}

export type DyeSet = Record<number, DyeColors>;

const NEUTRAL: DyeColors = {
  primary: new THREE.Color(0x8a8f96),
  secondary: new THREE.Color(0x4a4e54),
  roughness: 0.6,
  metalness: 0.4,
};

function colorFromArray(v: unknown): THREE.Color | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [r, g, b] = v as number[];
  if ([r, g, b].some((n) => typeof n !== "number")) return null;
  // Values may be 0..1 (albedo tint) or 0..255. Normalise heuristically.
  const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
  return new THREE.Color(r * scale, g * scale, b * scale).convertSRGBToLinear();
}

/** Pull colours out of one dye record, tolerant of several field names. */
function readDye(record: Record<string, unknown>): DyeColors {
  const mat = (record.material_properties ?? record) as Record<string, unknown>;
  const primary =
    colorFromArray(mat.primary_color) ??
    colorFromArray(mat.primaryAlbedoTint) ??
    colorFromArray(mat.primary_albedo_tint) ??
    NEUTRAL.primary.clone();
  const secondary =
    colorFromArray(mat.secondary_color) ??
    colorFromArray(mat.secondaryAlbedoTint) ??
    colorFromArray(mat.secondary_albedo_tint) ??
    NEUTRAL.secondary.clone();
  const roughness =
    typeof mat.roughness === "number" ? (mat.roughness as number) : NEUTRAL.roughness;
  const metalness =
    typeof mat.metalness === "number" ? (mat.metalness as number) : NEUTRAL.metalness;
  return { primary, secondary, roughness, metalness };
}

/**
 * Resolve a full dye set (slot index -> colours) from a gear-asset content
 * record and/or a gear JSON blob. Unknown slots fall back to neutral.
 */
export function resolveDyeSet(sources: {
  locked?: unknown[];
  custom?: unknown[];
  default?: unknown[];
}): DyeSet {
  const set: DyeSet = {};
  // Lowest priority first so higher priorities overwrite.
  for (const list of [sources.default, sources.custom, sources.locked]) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, slot) => {
      if (entry && typeof entry === "object") {
        set[slot] = readDye(entry as Record<string, unknown>);
      }
    });
  }
  return set;
}

/** Colours for a given dye slot, or neutral if unresolved. */
export function dyeForSlot(set: DyeSet, slot: number): DyeColors {
  return set[slot] ?? NEUTRAL;
}

export const NEUTRAL_DYE = NEUTRAL;

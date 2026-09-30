import type { GroupInfo } from "../geometry/buildGeometry";
import { transparentEffect } from "../geometry/transparentEffects";

export interface EffectEmission {
  color: readonly [number, number, number];
  intensity: number;
  source: "reference-hologram";
}

/** The digital hologram program omits its color constant from mobile exports.
 * Calibrated to the user's in-game reference: white-hot center, violet halo.
 * Scope this estimate to the complete effect signature, never an item hash or
 * every material with black emission. Explicit nonzero dye emission wins.
 */
export function effectEmissionFallback(groups: GroupInfo[]): EffectEmission | undefined {
  if (groups.some((group) => transparentEffect(group)?.kind === "digital-cloud")) {
    return { color: [0.3, 0.2, 1], intensity: 4, source: "reference-hologram" };
  }
}

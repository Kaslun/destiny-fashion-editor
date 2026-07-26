/**
 * Items whose glow is really an ABILITY-DRIVEN effect in-game — e.g. Thy
 * Fearful Symmetry's eyes/etchings and flame protrusions only ignite under
 * specific gameplay conditions — rather than an always-lit detail like a
 * helmet's power light or visor LED. Gates BOTH the shell's own gearstack
 * B-channel emissive AND any ability-VFX geometry (isAbilityVfxGroup in
 * gearMaterial.ts) for the item.
 *
 * The mobile gear asset data gives no flag for which is which (same problem
 * as the hood-hiding list in hoodHiding.ts) — worse, even the ability-VFX
 * geometry's OWN stage-part flag bit isn't a reliable universal signal: it
 * was tried unconditionally and immediately produced a false positive on
 * Relativism (2809120022), where the same bit sits on an ordinary
 * always-visible decal part (its hood), not optional VFX. So both stay a
 * hand-maintained allowlist of confirmed exceptions rather than a global
 * default or a bit-only heuristic.
 */
const GLOW_ANIMATED_ITEMS = new Set<number>([
  1400258673, // Thy Fearful Symmetry — flaming tiger mask
]);

export function itemHasAnimatedGlow(itemHash: number | null | undefined): boolean {
  return itemHash != null && GLOW_ANIMATED_ITEMS.has(itemHash);
}

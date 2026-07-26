/**
 * Builds Three.js NODE materials (TSL — WebGPU renderer, WebGL2 fallback) for
 * a gear mesh, one per geometry group.
 *
 * The material model follows Bungie's Destiny 2 shading (GDC 2018
 * "Translating Art into Technology"), layered on three.js's physical BRDF
 * (GGX + Smith visibility + Schlick Fresnel — the same core Bungie moved to),
 * with Disney-principled extensions where three exposes them:
 *
 *   gearstack channels (D2):  R = ambient occlusion
 *                             G = smoothness (inverted -> roughness)
 *                             B = encoded alpha-test + emissive (>~0.5 glows)
 *                             A = dye mask (>40/255) + un-dyed metalness
 *                                 (0..32/255) + wear mask (48/255..1)
 *
 * Dye slot & tint selection — Bungie's documented stage-part encoding:
 *   gear_dye_change_color_index = (slot << 1) | useSecondaryTint
 *   index 0/1 -> slot 0 primary/secondary, 2/3 -> slot 1, 4/5 -> slot 2,
 *   6/7 -> slot 3 (investment decal — never recoloured).
 * A per-pixel dyeslot plate, when the item ships one, refines the slot per
 * texel — R/G/B are independent per-slot weights (argmax picks slot0/1/2;
 * near-zero on all three = baked/no assignment), NOT a single scalar 1-based
 * id (see the dyeslot-decode comment in makeOpaque). Parity (primary vs
 * secondary) stays with the stage part.
 *
 * Per-tint PBR parameters come straight from the dye data (see
 * lib/bungie/gearDyeData.ts for the field mapping established against the
 * 8-helmet corpus): albedo + worn albedo tints, METALNESS
 * (material_params[3] — real data, no name heuristics), fuzz
 * (material_advanced_params[1] -> sheen lobe, Disney-style tinted toward the
 * albedo), roughness/worn-roughness/wear remaps, emissive tint+intensity,
 * and subsurface strength (-> MeshSSSNodeMaterial's wrapped-diffuse
 * approximation, matching Bungie's "wrapped diffuse + view-dependent
 * inverted lobe" translucency).
 *
 * The remap vec4s' exact runtime formula is not public (outputs can leave
 * [0,1] — Bungie's smoothness domain is signed, negative = fuzz), so the
 * interpretation is a LIVE-SWITCHABLE uniform — independently for roughness
 * and wear (see REMAP_MODES / setRoughnessRemapMode / setWearRemapMode)
 * rather than a baked-in guess:
 *   0 = range remap  (in_min, in_max, out_min, out_max)
 *   1 = scale/bias -> lerp of the (z, w) output band
 *   2 = scale/bias -> clamp to the [min(z,w), max(z,w)] band
 *
 * DYE only recolours the greyscale "change-colour" shell. The diffuse plate
 * also carries BAKED-COLOUR cells (e.g. Nighthawk's gold eye, its red/white
 * emblem) that must survive untouched — the plated dye is gated by pixel
 * saturation: near-grey texels take the tint, saturated texels pass through.
 *
 * Decal groups (stage-part flag 0x8) are opaque overlay geometry with their
 * own baked texture; they render with a polygon offset so they sit on the
 * shell without z-fighting.
 */
import * as THREE from "three/webgpu";
import {
  texture,
  uv,
  uniform,
  uniformArray,
  float,
  int,
  vec2,
  vec3,
  vec4,
  mix,
  clamp,
  step,
  smoothstep,
  min,
  max,
  floor,
  select,
  output,
  luminance,
  normalMap,
  sin,
  pow,
  dot,
  transformedNormalView,
  positionViewDirection,
  attribute,
} from "three/tsl";
import {
  dyeForSlot,
  rankSlotsSoftToHard,
  type DyeSet,
  type DyeTint,
} from "./gearDye";
import type { GroupInfo } from "@/lib/geometry/buildGeometry";

/**
 * Live gearstack-channel viewer. 0 = normal rendering; 1-4 override every pixel
 * with a greyscale view of the gearstack R/G/B/A channel (bright = high value);
 * 5 shows the RESOLVED dye slot per pixel, so material boundaries can be
 * inspected directly instead of guessed at from the lit render.
 * Wired to a uniform (not compiled in/out) so `setGearstackDebugChannel` can
 * flip it on an already-loaded model without rebuilding materials.
 */
export const GEARSTACK_CHANNELS = [
  "off",
  "r (ao)",
  "g (smoothness)",
  "b (emissive/alpha-test)",
  "a (dye mask / metalness / wear)",
  "resolved dye slot (red=0, green=1, blue=2, grey=undyed; dim=secondary tint)",
  "a-channel bands (8 hue steps: black,red,orange,yellow,green,cyan,blue,magenta)",
] as const;
export type GearstackDebugChannel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Interpretations of Bungie's `*_roughness_remap` / `*_wear_remap` vec4s —
 * the exact runtime formula is not public, so it's a live-switchable uniform.
 */
export const REMAP_MODES = [
  "range (in_min, in_max, out_min, out_max)",
  "scale/bias → band lerp",
  "scale/bias → band clamp",
] as const;
export type RemapMode = 0 | 1 | 2;
/**
 * Roughness and wear remaps are interpreted with INDEPENDENT modes — they
 * used to share one uniform, but that couples two unrelated empirical
 * findings:
 *   - Roughness reads better under "scale/bias → band clamp" (mode 2):
 *     confirmed on Celestial Nighthawk's gold, sharper/more accurate
 *     reflections than the range interpretation.
 *   - Wear must stay on "range" (mode 0) for at least that same item: its
 *     wearRemap vec4 (e.g. gold slot 0: [-3.406, 4.926, 0, 1]) has a bias
 *     term alone exceeding the clamp ceiling, so both scale/bias modes
 *     (1 and 2) saturate wearAmt to 1 for EVERY raw input — full-worn,
 *     always — which replaces the gold tint with wornAlbedo (a neutral
 *     grey) and reads as the gold plate turning silver. Range mode is the
 *     only one of the three that doesn't degenerate like this here.
 * If gold-turning-silver (or similar hue loss) shows up again after
 * changing either default, check whether that item's wearRemap has the
 * same saturating-bias shape before assuming it's a different bug.
 */
export const DEFAULT_ROUGHNESS_REMAP_MODE: RemapMode = 2;
export const DEFAULT_WEAR_REMAP_MODE: RemapMode = 0;

/**
 * Per-pixel material split for single-slot meshes (see the band-split note in
 * the header): thresholds cutting the dyeable A range into ranked slots,
 * ascending A = softer material. Defaults read off Cover of the Exile's
 * A-band visualization (debug channel 6): seam trim < 0.5 ≤ straps < 0.625 ≤
 * dome wraps.
 */
export interface BandTuning {
  /** below this raw A -> the hardest ranked slot (metal trim) */
  t1: number;
  /** between t1 and t2 -> the middle ranked slot; at/above -> softest (cloth) */
  t2: number;
}

export const BAND_DEFAULTS: BandTuning = { t1: 0.5, t2: 0.625 };

/**
 * material_advanced_params[0] (materialTypeId) values already confirmed
 * against the 8-item corpus gearDyeData.ts was built from — where the
 * standard gearstack B-channel "emissive" interpretation (see makeOpaque)
 * has held up. Relativism (2809120022) carries UNSEEN ids (0, 3, 4) —
 * almost certainly a distinct material family (its whole gimmick is a
 * prismatic/iridescent shimmer) — and applying the standard B-channel
 * interpretation there washes ~43% of its surface in a flat placeholder-red
 * emissive tint that doesn't exist in its real in-game render (confirmed:
 * removing the emissive term entirely reproduces the correct clean look,
 * rendering the actual parsed mesh with real sampled textures). Rather than
 * guess at what B actually encodes for an unrecognized material type, the
 * emissive contribution is suppressed for any materialTypeId outside this
 * set — safer than a wrong guess, and doesn't touch any already-confirmed
 * material's look.
 */
const KNOWN_EMISSIVE_MATERIAL_TYPE_IDS = [-1, 5, 25, 35, 105];

/**
 * Named VFX textures that drive Relativism's (2809120022) real iridescent
 * pattern shimmer, found by parsing the stage part's `shader.static_textures`
 * (see renderMetadata.ts StagePart.staticTextures / GroupInfo.patternTextures)
 * — a per-STAGE-PART signal, not the item/tint-wide materialTypeId guess this
 * replaced (see the removed "iridescent tint for unrecognized material types"
 * comment in git history if you need the old reasoning). Confirmed present on
 * roughly half of Relativism's shell stage parts (the rest are ordinary, no
 * static_textures at all) and absent on every stage part sampled from
 * Celestial Nighthawk (a known-good corpus item) — so requiring BOTH suffixes
 * is a specific positive match, unlike the single-flag-bit heuristics that
 * misfired twice before on this project (see glowAnimatedItems.ts). The
 * numeric prefix on the real entry name varies per item (e.g.
 * "3107841013_vfx_warpmap_noise_a"), hence a suffix match rather than exact.
 */
const PATTERN_NOISE_SUFFIX = "_vfx_warpmap_noise_a";
const PATTERN_RIPPLE_SUFFIX = "_vfx_warpmap_ripple_a";

/** Pick the exact noise/ripple entry names out of a stage part's static
 * texture list, if both are present. Case-insensitive suffix match. */
export function matchPatternTextureNames(
  names?: string[],
): { noise?: string; ripple?: string } {
  const list = names ?? [];
  const noise = list.find((n) => n.toLowerCase().endsWith(PATTERN_NOISE_SUFFIX));
  const ripple = list.find((n) => n.toLowerCase().endsWith(PATTERN_RIPPLE_SUFFIX));
  return { noise, ripple };
}

/**
 * Whether a geometry group's stage part carries the real pattern-shimmer
 * texture pair (see PATTERN_NOISE_SUFFIX/PATTERN_RIPPLE_SUFFIX above). A
 * group with only one of the two, or with an unrelated static_textures set
 * (e.g. Relativism's separate twirl/blob/darkness accent — unconfirmed,
 * intentionally out of scope here), falls through to the ordinary path
 * unchanged.
 */
export function isPatternGroup(g: GroupInfo): boolean {
  const { noise, ripple } = matchPatternTextureNames(g.patternTextures);
  return !!noise && !!ripple;
}

/**
 * Tuning constants for the pattern-shimmer warp (see isPatternGroup / the
 * block in makeOpaque). Bungie's exact runtime formula for these VFX warp
 * textures isn't public — same situation as REMAP_MODES above — so these are
 * guesses tuned by eye against Relativism's reference render, not derived
 * values. Expect to retune.
 */
const PATTERN_TILE_SCALE = 3.0;
const PATTERN_WARP_STRENGTH = 0.35;
const PATTERN_FLOW_SPEED = 0.06;
// How strongly the iridescent oil-slick overlays the base — 1.0 fully replaces
// the per-slot base colour (erasing the item's distinct sections into one
// purple), 0.0 disables the shimmer. Set low (user chose "favour distinct
// sections" over "vivid iridescence"): the base per-slot colour dominates and
// the shimmer is only a grazing-angle sheen on top, so slot 0/1/2 read as the
// distinct pale tones the data supports.
const PATTERN_SHEEN = 0.38;

/**
 * The secondary VFX accent some items carry alongside the shimmer pair — on
 * Relativism (2809120022) it's 8 shell stage parts (shader.type 8) naming a
 * twirl warp-map + a blob diffuse + a darkness plate. Read directly: the
 * twirl is a spiral RG flow field, the blob an organic RG noise, the darkness
 * plate a cloudy grayscale — together a swirling dark-energy overlay. Matched
 * by suffix (numeric prefix varies per item, like the shimmer pair).
 */
const ACCENT_TWIRL_SUFFIX = "_vfx_warpmap_twirl_a";
const ACCENT_BLOB_SUFFIX = "blob01_dif";
const ACCENT_DARKNESS_SUFFIX = "_darkness_plate";

/** Pick the twirl/blob/darkness accent entry names from a stage part's static
 * texture list, if all three are present. Case-insensitive suffix match. */
export function matchAccentTextureNames(
  names?: string[],
): { twirl?: string; blob?: string; darkness?: string } {
  const list = names ?? [];
  const twirl = list.find((n) => n.toLowerCase().endsWith(ACCENT_TWIRL_SUFFIX));
  const blob = list.find((n) => n.toLowerCase().endsWith(ACCENT_BLOB_SUFFIX));
  const darkness = list.find((n) => n.toLowerCase().endsWith(ACCENT_DARKNESS_SUFFIX));
  return { twirl, blob, darkness };
}

/**
 * Whether a group's stage part carries the full twirl+blob+darkness accent
 * trio (see matchAccentTextureNames). Requires all three — a partial match
 * falls through to the ordinary path. Mutually exclusive with isPatternGroup
 * (the shimmer pair and the accent trio are disjoint texture sets).
 */
export function isAccentGroup(g: GroupInfo): boolean {
  const { twirl, blob, darkness } = matchAccentTextureNames(g.patternTextures);
  return !!twirl && !!blob && !!darkness;
}

/**
 * Tuning constants for the swirling-darkness accent (see isAccentGroup / the
 * block in makeOpaque). Bungie's runtime composite for this trio isn't public,
 * so these are eyeballed against the live render — same caveat as the pattern
 * consts above. Expect to retune.
 */
const ACCENT_TILE_SCALE = 2.0;
const ACCENT_SWIRL_STRENGTH = 0.5;
const ACCENT_FLOW_SPEED = 0.08;
const ACCENT_STRENGTH = 0.85;

/**
 * How the A channel resolves per-pixel materials on single-slot meshes.
 * Bungie's material set is 3 dye slots x primary/secondary = 6 materials per
 * item (the TFS shader-icon rework shows all six colours per shader), so the
 * 6-band modes cut the dyeable range (48..255) into six equal (slot, parity)
 * bands. The band→pair ordering isn't publicly documented, so both orderings
 * are live-switchable; mode 0 keeps the hand-tunable 3-slot threshold split.
 */
/**
 * Whether the gearstack B-channel emissive (see the header doc) is an
 * ability-driven effect for THIS item (see lib/bungie/glowAnimatedItems.ts)
 * rather than an always-lit detail. Only those materials get the live
 * uGlowEnabled uniform + flicker animation — everything else keeps rendering
 * its emissive exactly as before, so this is purely additive.
 *
 * Defaults to OFF: on Thy Fearful Symmetry, "glow" isn't just an emissive
 * tint — isAbilityVfxGroup's flame-shaped geometry is real 3D protrusions
 * that don't exist anywhere in the item's actual in-game render (confirmed by
 * rendering the parsed mesh directly and comparing against the reference
 * screenshot). Defaulting this on would show that geometry unconditionally,
 * reproducing the exact "extra geometry" bug being fixed.
 */
export const DEFAULT_GLOW_ENABLED = false;

export const BAND_MODES = [
  "3-slot thresholds (t1/t2)",
  "6 bands, slot-major (s0P s0S s1P s1S s2P s2S)",
  "6 bands, parity-major (s0P s1P s2P s0S s1S s2S)",
] as const;
export type BandMode = 0 | 1 | 2;
// Changed from 2 (parity-major) to 0 (3-slot thresholds), 2026-07-24.
// BAND_DEFAULTS (t1/t2) were tuned against Cover of the Exile's A-band
// visualization for mode 0 specifically (see the doc comment above) — mode 2
// doesn't use t1/t2 at all (a generic 6-equal-band split instead), and git
// history shows no recorded comparison ever justified it as the default; it
// happened to land on the same slot assignment as mode 0 for Cover of the
// Exile (verified: pixel-identical render, no regression) purely because
// that item's A data splits cleanly either way. On Relativism (2809120022),
// which doesn't split as cleanly, mode 2's generic equal-band split washes
// the whole surface in one saturated tint; mode 0's tuned thresholds read
// far closer to the real in-game look. Re-verify against both items if this
// is ever reconsidered — don't trust a "looks reasonable" pick without it.
export const DEFAULT_BAND_MODE: BandMode = 0;

interface GearUniforms {
  uDebugChannel?: { value: number };
  uRoughnessRemapMode?: { value: number };
  uWearRemapMode?: { value: number };
  uBandMode?: { value: number };
  uBandT1?: { value: number };
  uBandT2?: { value: number };
  /** Only present on materials whose item is in GLOW_ANIMATED_ITEMS. */
  uGlowEnabled?: { value: number };
  /** Seconds, advanced by advanceGlowTime() from a render-loop hook — driven
   * from JS rather than TSL's built-in `time` node so the flicker doesn't
   * depend on the renderer's own timer wiring. */
  uGlowTime?: { value: number };
  /** Only present on pattern-shimmer materials (see isPatternGroup). Seconds,
   * advanced by advancePatternTime() — always increments (unlike uGlowTime,
   * the pattern shimmer isn't ability-gated, so there's no enable/disable
   * uniform, just a clock). */
  uPatternTime?: { value: number };
}

function forEachGearMaterial(
  root: THREE.Object3D,
  fn: (uniforms: GearUniforms) => void,
): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const uniforms = (m.userData as { uniforms?: GearUniforms }).uniforms;
      if (uniforms) fn(uniforms);
    }
  });
}

/** Push a debug-channel selection to every gearstack-enabled material under `root`. */
export function setGearstackDebugChannel(
  root: THREE.Object3D,
  channel: GearstackDebugChannel,
): void {
  forEachGearMaterial(root, (u) => {
    if (u.uDebugChannel) u.uDebugChannel.value = channel;
  });
}

/** Switch the roughness-remap-vec4 interpretation live on every material under `root`. */
export function setRoughnessRemapMode(root: THREE.Object3D, mode: RemapMode): void {
  forEachGearMaterial(root, (u) => {
    if (u.uRoughnessRemapMode) u.uRoughnessRemapMode.value = mode;
  });
}

/** Switch the wear-remap-vec4 interpretation live on every material under `root`. */
export function setWearRemapMode(root: THREE.Object3D, mode: RemapMode): void {
  forEachGearMaterial(root, (u) => {
    if (u.uWearRemapMode) u.uWearRemapMode.value = mode;
  });
}

/**
 * Toggle the ability-driven glow (see DEFAULT_GLOW_ENABLED) live on every
 * material under `root` that has one — a no-op on meshes with no glow-capable
 * material (both the shell's emissive and ability-VFX geometry only get one
 * when the item is on GLOW_ANIMATED_ITEMS — see GearMaterialOptions.
 * animatedGlow and isAbilityVfxGroup).
 */
export function setGlowEnabled(root: THREE.Object3D, enabled: boolean): void {
  forEachGearMaterial(root, (u) => {
    if (u.uGlowEnabled) u.uGlowEnabled.value = enabled ? 1 : 0;
  });
}

/**
 * Whether `root` has ANY glow-capable material (the shell's ability-gated
 * emissive, or ability-VFX flame/crystal geometry — see isAbilityVfxGroup) —
 * i.e. whether setGlowEnabled/advanceGlowTime would actually do anything.
 * Detected straight from the loaded model's materials rather than an item
 * hash, so UI code (e.g. a "glow" toggle button) doesn't carry its own
 * hash-lookup logic — though today that still bottoms out at the same
 * GLOW_ANIMATED_ITEMS allowlist one layer down, in loadGearModel.ts.
 */
export function hasAnimatedGlow(root: THREE.Object3D): boolean {
  let found = false;
  forEachGearMaterial(root, (u) => {
    if (u.uGlowEnabled) found = true;
  });
  return found;
}

/**
 * Advance the glow flicker clock by `deltaSeconds` on every material under
 * `root` that has one — call this from a render-loop hook (see GearModel.tsx)
 * so the animation actually progresses. Driven from JS instead of TSL's
 * built-in `time` node: that node is a page-global singleton updated by the
 * renderer's own frame timer, which is one more moving part to get right
 * around an async WebGPU backend and R3F's render loop — advancing our own
 * uniform explicitly is simple to reason about and easy to unit test.
 */
export function advanceGlowTime(root: THREE.Object3D, deltaSeconds: number): void {
  forEachGearMaterial(root, (u) => {
    if (u.uGlowTime) u.uGlowTime.value += deltaSeconds;
  });
}

/**
 * Advance the pattern-shimmer clock (see isPatternGroup) by `deltaSeconds` on
 * every material under `root` that has one — call this from the same
 * render-loop hook as advanceGlowTime (see GearModel.tsx / CharacterModel.tsx).
 * Always increments; there's no enable/disable toggle like glow's uGlowEnabled
 * since the shimmer isn't ability-gated.
 */
export function advancePatternTime(root: THREE.Object3D, deltaSeconds: number): void {
  forEachGearMaterial(root, (u) => {
    if (u.uPatternTime) u.uPatternTime.value += deltaSeconds;
  });
}

/** Push new A-band thresholds to every band-split material under `root`. */
export function setBandThresholds(
  root: THREE.Object3D,
  tuning: Partial<BandTuning>,
): void {
  forEachGearMaterial(root, (u) => {
    if (tuning.t1 !== undefined && u.uBandT1) u.uBandT1.value = tuning.t1;
    if (tuning.t2 !== undefined && u.uBandT2) u.uBandT2.value = tuning.t2;
  });
}

/** Switch the single-slot A-channel band decode live (see BAND_MODES). */
export function setBandMode(root: THREE.Object3D, mode: BandMode): void {
  forEachGearMaterial(root, (u) => {
    if (u.uBandMode) u.uBandMode.value = mode;
  });
}

export interface GearTextureMaps {
  diffuse?: THREE.Texture;
  normal?: THREE.Texture;
  gearstack?: THREE.Texture;
  /** per-pixel dye-slot mask plate — R/G/B = independent slot0/1/2 weights
   * (argmax picks the slot), near-zero on all three = baked art */
  dyeslot?: THREE.Texture;
  /** dedicated glow/illum mask (only some items have one) */
  emissive?: THREE.Texture;
  /** Pattern-shimmer warp textures (see isPatternGroup) — only present on
   * items shipping the real noise/ripple VFX texture pair. Grayscale,
   * repeat-wrapped, item-wide (not a plate: the same names can recur across
   * an item's separate geometry files). */
  patternNoise?: THREE.Texture;
  patternRipple?: THREE.Texture;
  /** Swirling-darkness accent trio (see isAccentGroup) — twirl warp field,
   * blob noise, cloudy darkness plate. Repeat-wrapped, item-wide. */
  accentTwirl?: THREE.Texture;
  accentBlob?: THREE.Texture;
  accentDarkness?: THREE.Texture;
}

export interface GearMaterialOptions {
  /** Apply gearstack AO + smoothness to the PBR response. */
  useGearstack?: boolean;
  /** Tint the albedo with the resolved dye colours. */
  applyDye?: boolean;
  /**
   * True when the item ships plate atlases (vs. a weapon's direct baked-
   * colour diffuse). Gates the saturation-based tint mask in makeOpaque —
   * but only for that GROUP's own resolved dye slot: a cloth-flagged slot
   * (cape body, scarf) always skips the gate and takes the dye directly,
   * since cloth diffuse art isn't reliably near-grey the way a metal shell's
   * change-colour art is. Pass the item-wide "has plates" signal here; the
   * per-group cloth exemption is applied inside makeOpaque, not here — a
   * mesh can mix cloth (cape) and metal (trim/medallion) groups, and an
   * item-wide cloth flag would wrongly strip the protective gate from the
   * metal groups too (see git history: 26be6e9, fa290cb).
   */
  plated?: boolean;
  /**
   * Whether this item ships as a single geometry file/part overall (e.g.
   * Cover of the Exile) — the only case the per-pixel A-channel band-split
   * (see needsBandSplit) is a sound inference. Multi-file items (e.g. a
   * cloak with a separate hood file) already carry real per-part slot
   * variation across their OTHER files; guessing hidden material bands
   * from one file's wear/AO shading — tuned against Cover of the Exile's
   * A-channel distribution (see BAND_DEFAULTS) — misfires as salt-and-
   * pepper speckling on a file that is legitimately single-material (the
   * main cape body). Defaults to true so existing single-mesh call sites
   * (incl. tests) are unaffected; loadGearModel passes the real item-wide
   * geometry-file count.
   */
  singlePart?: boolean;
  /**
   * True for items on the GLOW_ANIMATED_ITEMS allowlist (see
   * lib/bungie/glowAnimatedItems.ts) — gates the live uGlowEnabled uniform +
   * flicker onto BOTH the shell's own gearstack B-channel emissive AND any
   * ability-VFX geometry (isAbilityVfxGroup, e.g. flame protrusions). Neither
   * is safe to apply unconditionally: Bungie's data doesn't distinguish an
   * ability-driven glow from an always-lit detail (a visor LED bakes into the
   * B channel identically), and the VFX-geometry flag bit turned out to
   * correlate with real "hide by default" geometry on exactly one item and
   * with an ordinary always-visible decal part (Relativism's hood) on
   * another — see isAbilityVfxGroup. So both stay opt-in per confirmed item.
   */
  animatedGlow?: boolean;
  /**
   * The mesh's own BufferGeometry — only used to compute a per-vertex
   * "distance from the head's center" gradient for ability-VFX groups (see
   * isAbilityVfxGroup), so the flame geometry can shade dark at its base
   * (attached to the face) and hot/bright at its tip, radiating outward,
   * instead of a single flat colour. Optional: without it, VFX groups fall
   * back to a flat mid-gradient tone rather than erroring.
   */
  sourceGeometry?: THREE.BufferGeometry;
}

/**
 * Whether a mesh needs the per-pixel A-channel band split: it only applies
 * when the mesh gives us NO per-part slot variation to work with (every
 * non-glow stage part decodes to the same slot). Meshes with real per-part
 * slots (e.g. Nighthawk) keep their authored data untouched.
 *
 * No longer gated on dyeslot-plate presence (it used to bail to false
 * whenever `maps.dyeslot` existed, treating the two as mutually exclusive
 * strategies). Found empirically on Relativism (2809120022): its dyeslot
 * plate turned out to be a tiny 128x64 decorative icon (see the plate-stretch
 * fix earlier this session), not a body-wide ID mask — its gearstack A
 * channel, by contrast, clearly outlines a real distinct region (a circular
 * emblem + trim lines the debug "a (dye mask / metalness / wear)" channel
 * shows plainly) that the dyeslot-only path was silently discarding. See
 * makeOpaque: the band result is now used as the FALLBACK wherever the
 * dyeslot plate itself has no positive per-pixel assignment, not skipped
 * outright just because a plate exists.
 */
export function needsBandSplit(groups: GroupInfo[]): boolean {
  const partSlots = new Set(
    groups
      .filter((g) => !g.glow)
      .map((g) => decodeChangeColorIndex(g.dyeIndex).slot),
  );
  return partSlots.size === 1;
}

/**
 * Decode a raw gear_dye_change_color_index into slot + tint parity.
 *
 * Verified against the verbatim source of lowlidev's Spasm→Three.js port
 * (lowlines/destiny-tgx-loader, three.tgxloader.js parseStagePart): a plain
 * switch over the raw index, `usePrimaryColor` initialized true and set
 * false only on the odd cases (1, 3, 5). So EVEN index = primary, ODD index
 * = secondary. (A prior pass in this project flipped this based on a visual
 * read that turned out to be a misdiagnosis — the "plated" dye path exempts
 * bright/saturated diffuse texels from tinting regardless of which tint is
 * active, which can make a single tint look like two different colours
 * across one stage part. Restored to match the verified source.)
 */
export function decodeChangeColorIndex(index: number): {
  slot: number;
  useSecondary: boolean;
  decal: boolean;
} {
  const raw = Math.max(0, index);
  const slot = Math.min(raw >> 1, 3);
  return { slot, useSecondary: (raw & 1) === 1, decal: slot === 3 };
}

/**
 * Nighthawk's eye/faceplate: the diffuse is a gold emblem on black (~half/half).
 * Render it as REFLECTIVE gold metal, with the black surround cut out by alpha
 * so it's transparent (not an opaque black socket), plus a subtle self-glow.
 * The diffuse doubles as the alpha map — its green channel is high on the gold,
 * ~0 on the black, so `alphaTest` discards the black and keeps the gold.
 */
function makeGlow(maps: GearTextureMaps): THREE.Material {
  if (maps.diffuse) maps.diffuse.colorSpace = THREE.LinearSRGBColorSpace;
  return new THREE.MeshStandardNodeMaterial({
    map: maps.diffuse ?? null,
    alphaMap: maps.diffuse ?? null,
    transparent: true,
    alphaTest: 1,
    metalness: 0,
    roughness: 0,
    emissiveMap: maps.diffuse ?? null,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1,
    side: THREE.FrontSide,
  });
}

/**
 * Bit confirmed empirically on Thy Fearful Symmetry (1400258673): 3 of its 4
 * lod0 stage parts (604/652/790 triangles, raw flags 24592) are separate
 * flame-shaped crystal protrusions at the brow, temple, and jaw that do NOT
 * appear anywhere in the item's actual in-game render — rendering them as
 * ordinary opaque geometry (what makeOpaque would do) produces exactly the
 * jagged "extra geometry" spikes reported against the POC render (compare
 * the reference screenshot: a clean, smooth mask with none of these visible).
 * The main shell (4804 triangles) carries flags 16384 — the only bit that
 * differs from the VFX parts' 24592 that isn't already common to both.
 *
 * NOT a universal signal — confirmed wrong almost immediately: Relativism
 * (2809120022) has a stage part with flags 0x6008 (this bit set alongside
 * the ordinary decal bit 0x8) that's just its hood, an always-visible part,
 * rendered as invisible/glowing VFX geometry when this was applied
 * unconditionally. So — unlike FLAG_DECAL_PASS (0x8), which really is
 * universal — this stays gated behind the same per-item allowlist as the
 * shell's own animatedGlow flicker (see GearMaterialOptions.animatedGlow):
 * one correlation on one item isn't evidence of a general convention, and
 * Bungie's data gives no other way to tell "optional ability VFX" apart from
 * "ordinary decal part" for this bit specifically.
 */
const ABILITY_VFX_FLAG = 0x2000;

function isAbilityVfxGroup(g: GroupInfo): boolean {
  return ((g.flags ?? 0) & ABILITY_VFX_FLAG) !== 0;
}

/**
 * Precomputes, once per geometry, a per-vertex [0,1] "vfxRadial" attribute
 * covering every ability-VFX group: distance from the mesh's own bounding-
 * sphere centre, normalized within just the VFX vertices' own min/max range.
 * Since these groups are flame-shaped protrusions radiating outward from the
 * head (see isAbilityVfxGroup), this reads as ~0 at the base (attached to the
 * face) and ~1 at the tip regardless of which direction any one spike points
 * — used to shade a dark ember at the base fading to a hot bright tip.
 * Returns false (no attribute set) when there's nothing to compute from.
 */
function ensureVfxRadialAttribute(
  geometry: THREE.BufferGeometry,
  groups: GroupInfo[],
): boolean {
  if (geometry.getAttribute("vfxRadial")) return true;
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const idx = geometry.getIndex();
  const sphere = geometry.boundingSphere;
  if (!pos || !idx || !sphere) return false;

  const center = sphere.center;
  const radial = new Float32Array(pos.count);
  const touched = new Set<number>();
  let minR = Infinity;
  let maxR = -Infinity;
  for (const gg of geometry.groups) {
    const info = groups[gg.materialIndex ?? -1];
    if (!info || !isAbilityVfxGroup(info)) continue;
    for (let i = gg.start; i < gg.start + gg.count; i++) {
      const vi = idx.getX(i);
      if (touched.has(vi)) continue;
      touched.add(vi);
      const dx = pos.getX(vi) - center.x;
      const dy = pos.getY(vi) - center.y;
      const dz = pos.getZ(vi) - center.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      radial[vi] = r;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  if (touched.size === 0 || maxR <= minR) return false;
  for (const vi of touched) radial[vi] = (radial[vi] - minR) / (maxR - minR);
  geometry.setAttribute("vfxRadial", new THREE.BufferAttribute(radial, 1));
  return true;
}

/**
 * Ability-driven decorative geometry (see isAbilityVfxGroup) — invisible by
 * default and, when the SAME uGlowEnabled/uGlowTime uniforms used by the main
 * shell's glow (see makeOpaque) are toggled on via setGlowEnabled/
 * advanceGlowTime, shades like real fire rather than a flat glowing blob:
 *   - a dark-ember-to-hot-tip colour gradient along vfxRadial (base -> tip)
 *   - a per-material random phase offset so the mask's separate flame parts
 *     (brow/temple/jaw are 3 separate materials, one call each) flicker out
 *     of sync instead of pulsing in lockstep.
 * The phase offset is a genuine JS Math.random() constant baked in at build
 * time — NOT the classic `fract(sin(dot(p, magic)) * bigNumber)` shader hash.
 * That trick doesn't actually produce noise: sin() of a value that grows
 * roughly linearly across the surface just oscillates periodically, so it
 * reads as a visible rippled/moiré band pattern following the surface's
 * shape rather than randomness (confirmed — that's exactly what showed up
 * on a zoomed-in render of one of these flame parts). A single random float
 * per material has no spatial component to alias against, so it can't do that.
 * transparent + depthWrite=false so an invisible instance doesn't occlude or
 * z-fight with the shell underneath.
 */
function makeAbilityVfxGeometry(
  dyeIndex: number,
  dyes: DyeSet,
  hasRadialGradient: boolean,
): THREE.Material {
  const { slot, useSecondary } = decodeChangeColorIndex(dyeIndex);
  const slotDye = dyeForSlot(dyes, Math.min(slot, 2));
  const tint = useSecondary ? slotDye.secondary : slotDye.primary;

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  // Purely self-lit — no diffuse reflectance competing with the flame glow.
  mat.colorNode = vec4(0.0, 0.0, 0.0, 1.0);

  const uGlowEnabled = uniform(DEFAULT_GLOW_ENABLED ? 1 : 0);
  const uGlowTime = uniform(0);
  mat.userData.uniforms = { uGlowEnabled, uGlowTime };

  // Falls back to a flat mid-tone when no geometry was supplied to compute
  // the real gradient from (e.g. unit tests building materials in isolation).
  const radial = hasRadialGradient ? attribute<"float">("vfxRadial", "float") : float(0.6);

  const emberColor = vec3(tint.emissive.r, tint.emissive.g, tint.emissive.b).mul(0.4);
  const hotColor = vec3(1.0, 0.85, 0.4);
  const fireColor = mix(emberColor, hotColor, clamp(radial, 0.0, 1.0));

  const phase = Math.random() * Math.PI * 2;
  const flicker = sin(uGlowTime.mul(6.0).add(phase)).mul(0.5).add(0.5);
  const intensity = mix(0.35, 1.0, flicker).mul(mix(0.4, 1.0, radial)).mul(uGlowEnabled);

  mat.opacityNode = intensity;
  mat.emissiveNode = fireColor.mul(intensity).mul(2.0);
  return mat;
}

function makeOpaque(
  dyeIndex: number,
  dyes: DyeSet,
  maps: GearTextureMaps,
  opts: GearMaterialOptions,
  overlay = false,
  bandSplit = false,
  pattern = false,
  accent = false,
): THREE.Material {
  const { slot, useSecondary, decal: decalSlot } = decodeChangeColorIndex(dyeIndex);
  const slotClamped = Math.min(slot, 2);
  const slotDye = dyeForSlot(dyes, slotClamped);
  const ownTint: DyeTint = useSecondary ? slotDye.secondary : slotDye.primary;

  // Bungie's material set per item is 3 dye slots × primary/secondary = SIX
  // full materials (confirmed by the TFS shader-icon rework: all six colours
  // per shader) — so both parities' parameter arrays go to the GPU and the
  // (slot, parity) pair resolves per pixel. The stage part's parity is the
  // default; the 6-band A-channel modes override it per texel.
  const prims: DyeTint[] = [0, 1, 2].map((s) => dyeForSlot(dyes, s).primary);
  const secs: DyeTint[] = [0, 1, 2].map((s) => dyeForSlot(dyes, s).secondary);

  const mat = new THREE.MeshSSSNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.metalness = ownTint.metalness;
  mat.roughness = 0.6;

  if (overlay) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
  }

  if (maps.diffuse) maps.diffuse.colorSpace = THREE.SRGBColorSpace;
  if (maps.emissive) maps.emissive.colorSpace = THREE.SRGBColorSpace;
  const detailDiffuse = slotDye.detailDiffuse ?? null;
  const detailNormal = slotDye.detailNormal ?? null;
  if (detailDiffuse) {
    detailDiffuse.colorSpace = THREE.LinearSRGBColorSpace;
    detailDiffuse.wrapS = detailDiffuse.wrapT = THREE.RepeatWrapping;
  }
  if (detailNormal) {
    detailNormal.wrapS = detailNormal.wrapT = THREE.RepeatWrapping;
  }

  const wantGearstack = !!opts.useGearstack && !!maps.gearstack && !!maps.diffuse;
  const wantDetail = !!(detailDiffuse || detailNormal) && !!maps.diffuse;

  if (!wantGearstack && !wantDetail) {
    // Nothing dynamic to shade — plain textured material.
    mat.map = maps.diffuse ?? null;
    mat.normalMap = maps.normal ?? null;
    if (!maps.diffuse) mat.color = ownTint.albedo.clone();
    return mat;
  }

  // ---- live-tunable uniforms -----------------------------------------------
  const uDebugChannel = uniform(0);
  const uRoughnessRemapMode = uniform(DEFAULT_ROUGHNESS_REMAP_MODE as number);
  const uWearRemapMode = uniform(DEFAULT_WEAR_REMAP_MODE as number);
  const uBandMode = uniform(DEFAULT_BAND_MODE as number);
  const uBandT1 = uniform(BAND_DEFAULTS.t1);
  const uBandT2 = uniform(BAND_DEFAULTS.t2);
  const uGlowEnabled = opts.animatedGlow
    ? uniform(DEFAULT_GLOW_ENABLED ? 1 : 0)
    : undefined;
  const uGlowTime = opts.animatedGlow ? uniform(0) : undefined;
  mat.userData.uniforms = {
    uDebugChannel,
    uRoughnessRemapMode,
    uWearRemapMode,
    uBandMode,
    uBandT1,
    uBandT2,
    ...(uGlowEnabled ? { uGlowEnabled } : {}),
    ...(uGlowTime ? { uGlowTime } : {}),
  };

  // ---- per-(slot, parity) parameter table -------------------------------------
  // All 6 materials (3 slots × 2 tints) packed into ONE uniform vec4 array —
  // WebGPU caps uniform buffers at 12 per stage, so one binding with computed
  // indexing instead of one uniformArray per parameter. Layout per material
  // (ROWS_PER_MATERIAL rows): 0 albedo.rgb+metalness · 1 wornAlbedo.rgb+worn-
  // metalness · 2 roughnessRemap · 3 wornRoughnessRemap · 4 wearRemap ·
  // 5 emissive.rgb+intensity · 6 fuzz,detailBlend,sss,materialTypeId.
  const ROWS_PER_MATERIAL = 7;
  const matRows: THREE.Vector4[] = [];
  for (const list of [prims, secs]) {
    for (const t of list) {
      matRows.push(
        new THREE.Vector4(t.albedo.r, t.albedo.g, t.albedo.b, t.metalness),
        new THREE.Vector4(
          t.wornAlbedo.r,
          t.wornAlbedo.g,
          t.wornAlbedo.b,
          t.wornMetalness,
        ),
        new THREE.Vector4(...t.roughnessRemap),
        new THREE.Vector4(...t.wornRoughnessRemap),
        new THREE.Vector4(...t.wearRemap),
        new THREE.Vector4(t.emissive.r, t.emissive.g, t.emissive.b, t.emissiveIntensity),
        new THREE.Vector4(t.fuzz, t.detailBlend, t.sss, t.materialTypeId),
      );
    }
  }
  const uMaterialTable = uniformArray(matRows);

  const uvN = uv();

  // ---- gearstack decode ------------------------------------------------------
  // Channel encodings per Bungie (GDC 2018 value ranges): the alpha channel
  // packs three signals into bands — un-dyed metalness in the first 32 values,
  // the dye mask as a step at 40, wear from 48 up.
  const gs = wantGearstack
    ? texture(maps.gearstack!, uvN)
    : vec4(1.0, 0.5, 0.0, 0.0);
  // Floor AO's darkening instead of letting a baked 0 remove all indirect
  // light: on Memory of Cayde's cape, the gearstack R channel bakes a flat 0
  // across the whole spade/diagonal-band graphic (confirmed via the "r (ao)"
  // debug channel — a hard-edged silhouette exactly tracing the design, not
  // organic wrinkle shading), which renders that baked-white art as solid
  // black. A full-black AO texel removing 100% of indirect light is an
  // extreme case real-time PBR pipelines routinely clamp against (it rarely
  // reflects actual runtime lighting balance) — same rationale as the
  // alpha-test-cutout note below: the raw channel data doesn't always mean
  // what a literal reading suggests.
  const ao = mix(0.5, 1.0, gs.r);
  const smoothRaw = gs.g;
  // The discrete slot / dye-mask decode reads the A channel through HARD
  // thresholds (dyeMask step, and the band selects below). Mip minification
  // blurs A toward the UV-island padding at silhouette/grazing edges, ramping
  // it across those thresholds and flipping the resolved slot — a thin
  // wrong-slot fringe tracing the cape edge (visible in the "resolved dye
  // slot" debug view, and a faint wrong-material sliver in the real render).
  // Sample A at full resolution (mip 0) for those discrete decisions so band
  // boundaries stay crisp to the very edge. The CONTINUOUS ramps (undyedMetal,
  // wearRaw, plus AO/smoothness from RGB) keep the mip-filtered gs — they want
  // the smoothing and don't threshold, so they'd only alias if sharpened.
  const gsSharpA = wantGearstack
    ? texture(maps.gearstack!, uvN).level(int(0)).a
    : gs.a;
  const dyeMask = step(40 / 255, gsSharpA);
  const undyedMetal = clamp(gs.a.mul(255 / 32), 0.0, 1.0);
  const wearRaw = clamp(gs.a.sub(48 / 255).mul(255 / (255 - 48)), 0.0, 1.0);
  // B channel (per the documented ranges, verified against live plates where
  // ~95% of texels anchor at 32/255): alpha-test cut-outs occupy 0..32,
  // emissive 40..255, mutually exclusive. NOT a 128 midpoint.
  const emissiveMask = clamp(gs.b.sub(40 / 255).mul(255 / (255 - 40)), 0.0, 1.0);

  // ---- dye slot + tint-parity resolution ---------------------------------------
  // Per-pixel dyeslot plate when present (R/G/B = independent slot0/1/2
  // weights, argmax picks the slot — see the decode below); else — for
  // meshes whose stage parts all share ONE slot (e.g. Cover of the
  // Exile: a single part, dye index 3, yet visibly cloth + leather + metal +
  // gold trim) — a per-pixel decode of the gearstack A channel. Bungie's
  // material set is 3 slots × primary/secondary = 6 materials, so the 6-band
  // modes divide the dyeable range (48..255) into six equal (slot, parity)
  // bands; mode 0 keeps the tunable 3-slot threshold split (part parity).
  // The crown/emblem art sits BELOW the dye threshold = baked + un-dyed
  // metalness, untouched by any of this. slotF -1 = never dye.
  // TSL nodes are effectively untyped for TS here (uniformArray elements and
  // reassigned select() results) — one loose alias covers both cases.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type TSLNode = any;
  const ranked = rankSlotsSoftToHard(dyes);
  const partParity = float(useSecondary ? 1.0 : 0.0);
  let slotF: TSLNode;
  let parityF: TSLNode = partParity;

  // Per-pixel A-channel band decode (see needsBandSplit) — computed once,
  // used either as the PRIMARY slot source (no dyeslot plate) or as the
  // FALLBACK inside the dyeslot branch below wherever the plate itself has
  // no positive per-pixel assignment. These used to be mutually exclusive
  // (a plate's mere presence disabled band-split entirely); found empirically
  // on Relativism (2809120022) that its dyeslot plate is a tiny 128x64
  // decorative icon, not a body-wide mask, while its gearstack A channel
  // plainly outlines a real distinct region (a circular emblem + trim lines,
  // visible in the debug "a (dye mask / metalness / wear)" channel) that a
  // dyeslot-only decode was silently discarding down to a single flat slot.
  let bandSlotF: TSLNode | null = null;
  let bandParityF: TSLNode | null = null;
  if (bandSplit && ranked.length >= 2 && !decalSlot) {
    // mode 0 — ranked-slot thresholds on raw A (ascending = softer material).
    // Reads the sharp (mip-0) A so band boundaries don't fringe at silhouette
    // edges — see gsSharpA above.
    const soft = float(ranked[0]);
    const hard = float(ranked[ranked.length - 1]);
    const midBand =
      ranked.length >= 3
        ? select(gsSharpA.lessThan(uBandT2), float(ranked[1]), soft)
        : soft;
    const slot3 = select(gsSharpA.lessThan(uBandT1), hard, midBand);
    // 6 equal bands across the dyeable range
    const w = clamp(gsSharpA.sub(48 / 255).mul(255 / (255 - 48)), 0.0, 1.0);
    const band6 = clamp(floor(w.mul(6.0)), 0.0, 5.0);
    // mode 1 — slot-major: s0P s0S s1P s1S s2P s2S
    const si1 = floor(band6.mul(0.5));
    const par1 = band6.sub(si1.mul(2.0));
    // mode 2 — parity-major: s0P s1P s2P s0S s1S s2S
    const par2 = floor(band6.div(3.0));
    const si2 = band6.sub(par2.mul(3.0));
    bandSlotF = select(
      uBandMode.lessThan(0.5),
      slot3,
      select(uBandMode.lessThan(1.5), si1, si2),
    );
    bandParityF = select(
      uBandMode.lessThan(0.5),
      partParity,
      select(uBandMode.lessThan(1.5), par1, par2),
    );
  }

  if (maps.dyeslot) {
    // R/G/B are independent per-slot weights (slot0/slot1/slot2), NOT a
    // single scalar 1-based id — confirmed by rendering Relativism's real
    // dyeslot plate (2809120022) both ways and comparing against its actual
    // in-game look: reading only R (the old "floor(r*3+0.5)-1" decode) missed
    // real slot1/slot2 regions entirely wherever the plate expressed them via
    // G or B (e.g. a cyan G+B region), rendering them as flat undyed grey
    // instead of the tinted (blue) material they actually are. Taking the
    // argmax of the three channels — cheap, no shader rearchitecture needed —
    // recovered the same regions a full 3-way weighted blend did in that
    // comparison, so argmax is the one implemented here.
    const dyeslotTex = texture(maps.dyeslot, uvN);
    const qr = dyeslotTex.r;
    const qg = dyeslotTex.g;
    const qb = dyeslotTex.b;
    const sum = qr.add(qg).add(qb);
    const argmax = select(
      qr.greaterThanEqual(qg).and(qr.greaterThanEqual(qb)),
      float(0.0),
      select(qg.greaterThanEqual(qb), float(1.0), float(2.0)),
    );
    // near-zero on all three channels = no per-pixel assignment ("baked").
    const dyeslotSlot = select(sum.lessThan(0.03), float(-1), argmax);
    // The plate REFINES the group's slot per texel — it does not get to strand
    // the whole mesh undyed. Confirmed against Thy Fearful Symmetry's real
    // dyeslot plate (1400258673): every channel is uniformly 0 (100% "baked")
    // across the entire 64x64 mask, which — read literally as "0 = never dye"
    // — left the whole mesh unresolved/undyed. Falling back to the A-channel
    // band decode (when eligible) wherever the plate doesn't positively
    // assign a slot keeps the plate authoritative where it DOES have real
    // per-pixel data, while still recovering real per-pixel variation the
    // plate itself is silent on — a flat single-slot fallback would just
    // discard it (see Relativism's emblem above).
    const fallbackSlotF = bandSlotF ?? float(decalSlot ? -1 : slotClamped);
    slotF = select(dyeslotSlot.lessThan(-0.5), fallbackSlotF, dyeslotSlot);
    if (bandSlotF && bandParityF) {
      parityF = select(dyeslotSlot.lessThan(-0.5), bandParityF, partParity);
    }
  } else if (bandSlotF && bandParityF) {
    slotF = bandSlotF;
    parityF = bandParityF;
  } else {
    slotF = float(decalSlot ? -1 : slotClamped);
  }
  const dyeOn = !!opts.applyDye && wantGearstack;
  const isDyed = dyeOn ? step(-0.5, slotF).mul(dyeMask) : float(0.0);

  // Per-(slot, parity) lookup into the packed material table: material index =
  // parity*3 + slot, row offset per the layout above. uniformArray elements
  // are untyped for TS, hence the cast.
  const slotRounded = floor(clamp(slotF, 0.0, 2.0).add(0.5));
  const matRow = (row: number) =>
    vec4(
      uMaterialTable.element(
        int(
          parityF
            .mul(3.0)
            .add(slotRounded)
            .mul(ROWS_PER_MATERIAL)
            .add(row + 0.5),
        ),
      ) as TSLNode,
    );

  // ---- material-type gate (see KNOWN_EMISSIVE_MATERIAL_TYPE_IDS) --------------
  // Resolved per-pixel from the SAME (slot, parity) the rest of this function
  // uses — shared by the emissive gate below and the iridescent tint above
  // the albedo assignment.
  const materialTypeId = matRow(6).w;
  let isKnownMaterial = materialTypeId.equal(KNOWN_EMISSIVE_MATERIAL_TYPE_IDS[0]);
  for (const id of KNOWN_EMISSIVE_MATERIAL_TYPE_IDS.slice(1)) {
    isKnownMaterial = isKnownMaterial.or(materialTypeId.equal(id));
  }
  const knownMaterialGate = select(isKnownMaterial, float(1.0), float(0.0));

  // ---- remap (interpretation switchable at runtime — see REMAP_MODES) --------
  // Roughness and wear use INDEPENDENT mode uniforms (see the doc comment on
  // DEFAULT_ROUGHNESS_REMAP_MODE/DEFAULT_WEAR_REMAP_MODE): band-clamp reads
  // better for roughness/reflections, but the same mode saturates at least
  // one real item's wear remap to "always fully worn", overwriting its tint
  // with wornAlbedo.
  const applyRemap = (raw: TSLNode, r: TSLNode, modeUniform: TSLNode) => {
    const tRange = clamp(raw.sub(r.x).div(max(r.y.sub(r.x), 1e-5)), 0.0, 1.0);
    const range = mix(r.z, r.w, tRange);
    const tBias = clamp(raw.mul(r.x).add(r.y), 0.0, 1.0);
    const lerpBand = mix(r.z, r.w, tBias);
    const clampBand = clamp(raw.mul(r.x).add(r.y), min(r.z, r.w), max(r.z, r.w));
    return select(
      modeUniform.lessThan(0.5),
      range,
      select(modeUniform.lessThan(1.5), lerpBand, clampBand),
    );
  };

  const wearAmt = clamp(applyRemap(wearRaw, matRow(4), uWearRemapMode), 0.0, 1.0).mul(isDyed);

  // ---- albedo -----------------------------------------------------------------
  let albedo = maps.diffuse
    ? texture(maps.diffuse, uvN).rgb
    : vec3(ownTint.albedo.r, ownTint.albedo.g, ownTint.albedo.b);

  if (detailDiffuse && maps.diffuse) {
    // Tiled micro-surface detail (fabric weave, metal grain) blended with
    // Bungie's own Spasm operator — detail·saturate(base·4) + saturate(base −
    // 0.25) — gated per-pixel by the (slot, parity) detail-blend strength:
    // 0 on Nighthawk's gold plate, 1 on cloth. The old ±luminance wiggle was
    // far too weak to read as cloth.
    const dt = slotDye.detailDiffuseTransform;
    const dUv = uvN.mul(vec2(dt[0], dt[1])).add(vec2(dt[2], dt[3]));
    const detailRgb = texture(detailDiffuse, dUv).rgb;
    const blended = detailRgb
      .mul(clamp(albedo.mul(4.0), 0.0, 1.0))
      .add(clamp(albedo.sub(0.25), 0.0, 1.0));
    albedo = mix(albedo, blended, matRow(6).y);
  }

  const tintN = matRow(0).xyz;
  const wornN = matRow(1).xyz;
  // Cloth regions skip the plated saturation gate even on plate-based items
  // (see GearMaterialOptions.plated) — decided per-group from this group's
  // own resolved slot, not an item-wide flag.
  const gatedTint = !!opts.plated && !slotDye.cloth;
  let dyedColor;
  if (gatedTint) {
    // Brightness/saturation gate for baked-colour art, measured on the RAW
    // albedo BEFORE AO darkening — base material (grey OR light) takes the
    // tint; only distinctly COLOURED art (saturated) and genuinely NEAR-WHITE
    // baked insignia pass through untinted.
    //
    // Destiny's dye model MULTIPLIES the tint into the change-colour diffuse,
    // so a light/grey base is exactly what becomes a coloured piece (white ×
    // blue = blue). The brightness ceiling used to sit at 0.3–0.48, which
    // wrongly protected ordinary base material: on Relativism (2809120022) the
    // diffuse mean luminance is 0.42 with ~0 saturation, so that ceiling
    // suppressed the tint on ~45% of the cape and every resolved slot rendered
    // the same pale colour despite the dyeslot map showing three distinct
    // materials. A direct A/B (grey gate fully open vs gated) confirmed the
    // gate was hiding real per-slot variation — the darker slot-2 leather
    // panel + lacing only read with the tint applied. Ceiling raised to
    // 0.85–0.97 so ONLY near-pure-white texels (genuine baked insignia) are
    // spared; everything else takes its slot's tint. The saturation term still
    // protects coloured decals, and sub-dye-threshold baked art is already
    // excluded upstream by dyeMask (A < 40 → isDyed 0). Retune the ceiling if
    // a real white emblem on some item starts taking dye.
    const lum = luminance(albedo);
    const sat = max(albedo.r, max(albedo.g, albedo.b)).sub(
      min(albedo.r, min(albedo.g, albedo.b)),
    );
    const greyMask = smoothstep(0.06, 0.16, sat)
      .oneMinus()
      .mul(smoothstep(0.85, 0.97, lum).oneMinus())
      .mul(smoothstep(0.04, 0.11, lum));
    const m = isDyed.mul(greyMask);
    // Blend the TINT colours by wear amount before applying to albedo, once —
    // not a second multiply on top of the already-tinted result. wornAlbedo
    // is a normalized [0,1] colour (e.g. 0.55 grey), so multiplying an
    // already-tinted (already-dark) colour by it can only ever darken
    // further, never reveal the lighter worn material Bungie's data encodes.
    const wearTint = mix(tintN, wornN, wearAmt.mul(greyMask));
    dyedColor = mix(albedo, clamp(albedo.mul(1.7), 0.0, 1.1).mul(wearTint), m);
  } else {
    const wearTint = mix(tintN, wornN, wearAmt);
    dyedColor = mix(albedo, albedo.mul(wearTint), isDyed);
  }

  // Shared animation clock for the pattern shimmer + darkness accent — created
  // once if either effect is active on this material, advanced by
  // advancePatternTime() from the render loop. `pattern`/`accent` are fixed
  // per stage part at material-build time (not runtime uniforms), so which
  // effect runs is a plain JS branch.
  const wantsPattern = pattern && !!maps.patternNoise && !!maps.patternRipple;
  const wantsAccent =
    accent && !!maps.accentTwirl && !!maps.accentBlob && !!maps.accentDarkness;
  const uPatternTime = wantsPattern || wantsAccent ? uniform(0) : null;
  if (uPatternTime) {
    mat.userData.uniforms = { ...mat.userData.uniforms, uPatternTime };
  }

  // ---- pattern shimmer (see isPatternGroup) -----------------------------------
  // Bungie confirmed an "Iridescence" material system exists in Destiny 2's
  // renderer (GDC 2018, "Physically Inspired Shading in Destiny 2"). Rather
  // than guess WHICH materials use it from materialTypeId (the old approach —
  // see git history), this is gated by the real per-stage-part signal: the
  // group's own stage part shipping the confirmed noise+ripple VFX texture
  // pair (see PATTERN_NOISE_SUFFIX/PATTERN_RIPPLE_SUFFIX, isPatternGroup).
  //
  // Base gradient (white -> pale blue -> pink toward grazing angles) is the
  // same Fresnel approximation verified by eye against Relativism's reference
  // render in the previous materialTypeId-gated version. New here: the ripple
  // texture's per-pixel sample flows the UV fed into the noise sample (a
  // standard two-texture distortion technique), and both are advanced by
  // uPatternTime, so the shimmer actually warps/travels across the surface
  // instead of being a static angle-only gradient. Tiling/warp-strength/speed
  // (PATTERN_TILE_SCALE/PATTERN_WARP_STRENGTH/PATTERN_FLOW_SPEED) are
  // unverified guesses — see their doc comment — expect to retune against a
  // live render.
  if (wantsPattern && uPatternTime && maps.patternNoise && maps.patternRipple) {
    const flow = vec2(
      uPatternTime.mul(PATTERN_FLOW_SPEED),
      uPatternTime.mul(PATTERN_FLOW_SPEED * 0.7),
    );
    const rippleUv = uvN.mul(PATTERN_TILE_SCALE).add(flow);
    const rippleOffset = texture(maps.patternRipple, rippleUv)
      .rg.sub(0.5)
      .mul(PATTERN_WARP_STRENGTH);
    const noiseUv = uvN
      .mul(PATTERN_TILE_SCALE)
      .add(rippleOffset)
      .sub(vec2(uPatternTime.mul(PATTERN_FLOW_SPEED * 0.5), 0.0));
    const noiseSample = texture(maps.patternNoise, noiseUv).r;

    const fresnel = pow(
      clamp(dot(transformedNormalView, positionViewDirection), 0.0, 1.0).oneMinus(),
      3.0,
    );
    // Reference render (Relativism's real in-game look, compared directly
    // against this session) shows strong blue/purple mottling across the
    // WHOLE cape, tracking the fabric's folds — not just a thin band at
    // grazing silhouette edges the way a pure Fresnel term alone produces.
    // So the noise sample (the fabric-pattern-driven signal) is weighted as
    // a near-equal, independent driver of the colour mix rather than a small
    // perturbation added on top of fresnel — it alone can push well into
    // colour territory even on a surface facing the camera dead-on. Weights
    // and thresholds are still unverified guesses tuned by eye against that
    // reference, not derived values — expect to retune further.
    // Fresnel-dominant (user chose distinct sections): the iridescence
    // concentrates at grazing angles / fold silhouettes rather than spreading
    // across every face-on texel, so flat surfaces keep their per-slot base
    // colour and only the edges catch the oil-slick sheen.
    const colorMix = clamp(fresnel.mul(0.85).add(noiseSample.mul(0.35)), 0.0, 1.0);
    // Round 3 (tuned by eye against the user's in-game reference): the earlier
    // palette was too desaturated (every stop sat near 0.6–1.0), so
    // multiplying it into the base kept the cape pale. The reference is a
    // vivid oil-slick — a SATURATED spectrum sweeping white → blue → purple →
    // magenta as the noise/fresnel term rises, richest on the lower cape.
    // Lower off-channels = more saturation survives the multiply. Pearl-white
    // stays the low-mix base so the near-white upper body (slot 0) reads pale
    // while the bluer lower cape (slot 1) pushes deep into blue/purple.
    const iridescentWhite = vec3(0.9, 0.93, 1.0);
    const iridescentBlue = vec3(0.3, 0.46, 1.0);
    const iridescentPurple = vec3(0.5, 0.28, 0.98);
    const iridescentMagenta = vec3(0.88, 0.36, 0.9);
    const lowMix = mix(iridescentWhite, iridescentBlue, smoothstep(0.0, 0.4, colorMix));
    const midMix = mix(lowMix, iridescentPurple, smoothstep(0.4, 0.72, colorMix));
    const iridescentTint = mix(midMix, iridescentMagenta, smoothstep(0.72, 1.0, colorMix));
    // Pearl-white upper vs vivid lower cape: the reference keeps the near-white
    // upper body (slot 0) pastel while the bluer lower cape (slot 1) saturates
    // deep into blue/purple. A saturated tint MULTIPLIED into a near-white base
    // would recolour it fully (white × purple = purple), erasing that gradient.
    // So the colour shift is scaled DOWN on bright bases — the shimmer tint is
    // pulled toward neutral in proportion to the base's own luminance, leaving
    // the pearl upper a subtle sheen and letting the darker cloth take the full
    // oil-slick. Capped at 0.7 so even the brightest base keeps some iridescence.
    const baseLum = luminance(dyedColor);
    const shimmerDesat = smoothstep(0.45, 0.8, baseLum).mul(0.82);
    const shimmerTint = mix(iridescentTint, vec3(1.0, 1.0, 1.0), shimmerDesat);
    // Apply the iridescence as a partial OVERLAY, not a full multiply-replace.
    // A real iridescent material shows the section's own base colour with a
    // sheen on top — a blue section stays blue, a grey section stays grey.
    // Multiplying fully by a saturated tint erased that: every dye slot (the
    // item's distinct "pieces") collapsed to the same purple. Blending keeps
    // PATTERN_SHEEN of each pixel's own per-slot dyedColor so the sections
    // read, while still carrying the strong oil-slick the reference shows.
    const shimmered = dyedColor.mul(shimmerTint).mul(1.25);
    dyedColor = mix(dyedColor, shimmered, PATTERN_SHEEN);
  }

  // ---- swirling-darkness accent (see isAccentGroup) ---------------------------
  // The type-8 accent trio: a twirl warp-map (spiral RG flow field), a blob
  // noise, and a cloudy darkness plate. Composited as an animated dark-energy
  // overlay: the twirl field swirls the sample UVs over time, the darkness
  // plate × blob noise gives a moving cloud density, and the base colour is
  // pushed toward a near-black cool void where that density is high. Bungie's
  // real composite isn't public; the blend + ACCENT_* consts are eyeballed
  // against the live render (expect to retune) — but the WHICH (this exact
  // group) is the real per-stage-part signal, not a guess.
  if (
    wantsAccent &&
    uPatternTime &&
    maps.accentTwirl &&
    maps.accentBlob &&
    maps.accentDarkness
  ) {
    const baseUv = uvN.mul(ACCENT_TILE_SCALE);
    const twirl = texture(maps.accentTwirl, baseUv).rg.sub(0.5);
    const swirlUv = baseUv
      .add(twirl.mul(ACCENT_SWIRL_STRENGTH))
      .add(vec2(uPatternTime.mul(ACCENT_FLOW_SPEED), uPatternTime.mul(ACCENT_FLOW_SPEED * -0.6)));
    const blob = texture(maps.accentBlob, swirlUv).r;
    const darkness = texture(
      maps.accentDarkness,
      swirlUv.mul(0.7).sub(vec2(uPatternTime.mul(ACCENT_FLOW_SPEED * 0.4), 0.0)),
    ).r;
    const voidAmt = clamp(darkness.mul(blob.add(0.4)).mul(ACCENT_STRENGTH), 0.0, 1.0);
    const voidColor = vec3(0.02, 0.02, 0.05);
    dyedColor = mix(dyedColor, voidColor, voidAmt);
  }

  mat.colorNode = vec4(dyedColor, 1.0);

  if (wantGearstack) {
    // ---- smoothness -> roughness (signed domain: negative smoothness = fuzz) --
    const smoothBase = applyRemap(smoothRaw, matRow(2), uRoughnessRemapMode);
    const smoothWorn = applyRemap(smoothRaw, matRow(3), uRoughnessRemapMode);
    const smoothness = clamp(
      mix(smoothRaw, mix(smoothBase, smoothWorn, wearAmt), isDyed),
      -1.0,
      1.0,
    );
    const fuzzFromNegativeSmoothness = max(smoothness.negate(), 0.0);
    mat.roughnessNode = clamp(max(smoothness, 0.0).oneMinus(), 0.04, 1.0);

    // ---- metalness: dyed regions use the tint's authored metalness (worn state
    // can differ — paint scratching to bare metal); un-dyed keeps the gearstack's.
    const metalDyed = mix(matRow(0).w, matRow(1).w, wearAmt);
    mat.metalnessNode = mix(undyedMetal, metalDyed, isDyed);

    // ---- AO --------------------------------------------------------------------
    mat.aoNode = ao;

    // ---- fuzz -> sheen (Disney: an extra Fresnel-shaped grazing lobe, tinted
    // toward the base colour), driven by the dye's authored fuzz amount plus any
    // negative-smoothness fuzz from the remap.
    const anyFuzz =
      prims.some((t) => t.fuzz > 0) ||
      secs.some((t) => t.fuzz > 0) ||
      [0, 1, 2].some((s) => dyeForSlot(dyes, s).cloth);
    if (anyFuzz) {
      const fuzzAmt = clamp(
        matRow(6).x.add(fuzzFromNegativeSmoothness),
        0.0,
        1.0,
      ).mul(dyeOn ? isDyed : float(1.0));
      mat.sheenNode = dyedColor.mul(fuzzAmt);
      mat.sheenRoughnessNode = float(0.9);
    }

    // ---- emissive: gearstack B band × the slot's emissive tint & intensity ----
    // Gated by the resolved tint's materialTypeId (see knownMaterialGate above
    // / KNOWN_EMISSIVE_MATERIAL_TYPE_IDS).
    //
    // Placeholder emissive tints (an unset default repeated identically across
    // every slot — e.g. Relativism's (1,0,0,1) primaries / (1,1,1,1)
    // secondaries) are zeroed upstream at the data level, so they never reach
    // here — see neutralizePlaceholderEmissive in gearDye.ts. Anything left in
    // matRow(5) at this point is authored glow.
    const em = matRow(5);
    let emissive = em.xyz.mul(em.w).mul(emissiveMask).mul(1.25).mul(knownMaterialGate);
    if (maps.emissive) {
      emissive = emissive.add(texture(maps.emissive, uvN).rgb.mul(1.5));
    }
    if (uGlowEnabled && uGlowTime) {
      // Ability-driven glow (see GearMaterialOptions.animatedGlow): flicker
      // between 55% and 100% intensity instead of the flat, always-on band
      // the raw B-channel data produces, and let uGlowEnabled kill it
      // entirely — the mobile gear data has no "ability active" signal to
      // drive this for real, so it's a live toggle rather than a guess.
      // uGlowTime is advanced from JS (see advanceGlowTime), not TSL's
      // built-in `time` node.
      const flicker = sin(uGlowTime.mul(5.0)).mul(0.5).add(0.5);
      emissive = emissive.mul(mix(0.55, 1.0, flicker)).mul(uGlowEnabled);
    }
    mat.emissiveNode = emissive;

    // ---- alpha-test cut-outs: NOT applied here ------------------------------------
    // The doc's "~32 values" band for alpha-test cutouts is NOT a universal
    // opaque-anchor-at-32 rule: sampled directly against Celestial Nighthawk's
    // own UVs, its solid dome shell (no fringe/cutout geometry at all) is 27%
    // raw B=0 texels. A blind discard-below-half-opacity treated that as a
    // cutout and punched real holes through the mesh. Bungie's alpha-test
    // sub-band is evidently only meaningful for stage parts that are actually
    // flagged as alpha-tested (cape fringe, hair, grates) — a signal not
    // present in the render metadata we parse today. Discarding on the raw B
    // value with no such gate is unsafe across items; leaving pixels opaque
    // (no discard) until that per-part flag is identified is the correct
    // default.

    // ---- subsurface scattering (Bungie: wrapped diffuse + inverted view-
    // dependent lobe; three's SSS node material implements the same family of
    // approximation). Enabled only when the dye ships a strength.
    const sssStrength = Math.max(0, Math.min(1, (ownTint.sss || 0) / 50));
    if (sssStrength > 0) {
      mat.thicknessColorNode = dyedColor.mul(sssStrength);
      mat.thicknessDistortionNode = float(0.1);
      mat.thicknessAttenuationNode = float(0.8);
      mat.thicknessPowerNode = float(2.0);
      mat.thicknessScaleNode = float(4.0);
    }

    // ---- debug channel viewer (unlit override of the final output) ------------
    // Slot view: secondary-parity texels show at half brightness so the
    // (slot, parity) pair is readable at a glance.
    const slotColor = select(
      slotF.lessThan(-0.5).or(dyeMask.lessThan(0.5)),
      vec3(0.15, 0.15, 0.15),
      select(
        slotF.lessThan(0.5),
        vec3(1.0, 0.0, 0.0),
        select(slotF.lessThan(1.5), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)),
      ).mul(parityF.mul(-0.5).add(1.0)),
    );
    // Channel 6: quantize A into 8 bands with distinct hues, to inspect
    // whether/where the wear channel doubles as a per-pixel material id on
    // single-stage-part items (e.g. Cover of the Exile).
    const band = floor(gs.a.mul(8.0));
    const bandColor = select(
      band.lessThan(0.5),
      vec3(0.05, 0.05, 0.05),
      select(
        band.lessThan(1.5),
        vec3(1.0, 0.0, 0.0),
        select(
          band.lessThan(2.5),
          vec3(1.0, 0.5, 0.0),
          select(
            band.lessThan(3.5),
            vec3(1.0, 1.0, 0.0),
            select(
              band.lessThan(4.5),
              vec3(0.0, 1.0, 0.0),
              select(
                band.lessThan(5.5),
                vec3(0.0, 1.0, 1.0),
                select(band.lessThan(6.5), vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 1.0)),
              ),
            ),
          ),
        ),
      ),
    );
    const dbg = select(
      uDebugChannel.lessThan(1.5),
      vec3(gs.r),
      select(
        uDebugChannel.lessThan(2.5),
        vec3(gs.g),
        select(
          uDebugChannel.lessThan(3.5),
          vec3(gs.b),
          select(
            uDebugChannel.lessThan(4.5),
            vec3(gs.a),
            select(uDebugChannel.lessThan(5.5), slotColor, bandColor),
          ),
        ),
      ),
    );
    mat.outputNode = select(uDebugChannel.greaterThan(0.5), vec4(dbg, 1.0), output);
  }

  // ---- detail normal blended over the plate normal ----------------------------
  if (maps.normal) {
    let packedNormal = texture(maps.normal, uvN).xyz;
    if (detailNormal) {
      const nt = slotDye.detailNormalTransform;
      const dnUv = uvN.mul(vec2(nt[0], nt[1])).add(vec2(nt[2], nt[3]));
      const base = packedNormal.mul(2.0).sub(1.0);
      const detail = texture(detailNormal, dnUv).xyz.mul(2.0).sub(1.0);
      const strength = matRow(6).y.mul(0.4);
      const combined = vec3(base.xy.add(detail.xy.mul(strength)), base.z).normalize();
      packedNormal = combined.mul(0.5).add(0.5);
    }
    mat.normalNode = normalMap(packedNormal);
  }

  return mat;
}

export function createGearMaterials(
  groups: GroupInfo[],
  dyes: DyeSet,
  maps: GearTextureMaps = {},
  opts: GearMaterialOptions = {},
): THREE.Material[] {
  if (groups.length === 0) {
    return [makeOpaque(0, dyes, maps, opts)];
  }
  // The singlePart gate exists to stop band-split guessing wrongly when it
  // would be the PRIMARY slot source on a multi-file item (see the doc
  // comment above and Cayde's cloak speckle history) — but when a dyeslot
  // plate exists, band-split is only ever used as makeOpaque's FALLBACK for
  // texels the plate itself leaves unassigned (see needsBandSplit), not as
  // the primary decision-maker. That's a much lower-risk use the singlePart
  // caution wasn't calibrated against, so it's skipped in that case —
  // otherwise Relativism (2 real geometry files: shell + cloth, so
  // singlePart is correctly false) would never get a chance to recover its
  // emblem/trim-line region at all, even though the plate itself concedes no
  // data there.
  const bandSplit =
    ((opts.singlePart ?? true) || !!maps.dyeslot) && needsBandSplit(groups);
  // isAbilityVfxGroup is gated behind animatedGlow (per-item allowlist), NOT
  // applied unconditionally — a real counter-example turned up almost
  // immediately: Relativism (2809120022) has a stage part with flags 0x6008,
  // i.e. the SAME 0x2000 bit found on Thy Fearful Symmetry's flame geometry,
  // set alongside the ordinary decal bit (0x8) on what all evidence says is
  // just its hood — an always-visible part, not optional ability VFX. The
  // bit correlated with real ability-VFX geometry on exactly one item; that's
  // not enough evidence to treat it as a universal signal. See
  // GearMaterialOptions.animatedGlow for the actual gating.
  const hasVfxGroups = !!opts.animatedGlow && groups.some(isAbilityVfxGroup);
  const hasRadialGradient =
    hasVfxGroups && !!opts.sourceGeometry && ensureVfxRadialAttribute(opts.sourceGeometry, groups);
  return groups.map((g) => {
    if (g.glow) return makeGlow(maps);
    if (opts.animatedGlow && isAbilityVfxGroup(g)) {
      return makeAbilityVfxGeometry(g.dyeIndex, dyes, hasRadialGradient);
    }
    return makeOpaque(
      g.dyeIndex,
      dyes,
      maps,
      opts,
      g.decal,
      bandSplit,
      isPatternGroup(g),
      isAccentGroup(g),
    );
  });
}

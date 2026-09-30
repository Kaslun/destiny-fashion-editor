/**
 * Destiny 2 mobile gear material model. Sources and known limits are recorded
 * in docs/DESTINY-MATERIALS.md. Three supplies the physical lighting lobes.
 */
import * as THREE from "three/webgpu";
import {
  texture,
  textureLoad,
  ivec2,
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
  mrt,
  luminance,
  normalMap,
  sin,
  pow,
  dot,
  normalView,
  positionViewDirection,
  attribute,
  sRGBTransferEOTF,
  sqrt,
} from "three/tsl";
import {
  dyeForSlot,
  rankSlotsSoftToHard,
  type DyeSet,
  type DyeTint,
} from "./gearDye";
import { authoredRemap, GEARSTACK } from "./destinyMaterialModel";
import { effectEmissionFallback, type EffectEmission } from "./effectEmission";
import type { GroupInfo } from "@/lib/geometry/buildGeometry";
import { isRayGlowGroup, matchRayTextureNames, matchCloudTextureNames, transparentEffect, prepareEffectUVs } from "../geometry/transparentEffects";

export const GEARSTACK_CHANNELS = [
  "off",
  "r (ao)",
  "g (smoothness)",
  "b (emissive/alpha-test)",
  "a (dye mask / metalness / wear)",
  "resolved dye slot (red=0, green=1, blue=2, grey=undyed; dim=secondary tint)",
  "a-channel bands (8 hue steps: black,red,orange,yellow,green,cyan,blue,magenta)",
  "resolved metalness (black=dielectric, white=metal)",
  "decoded alpha (red=undyed metal, green=dye, blue=wear signal)",
  "estimated boundaries (yellow=changed alpha class)",
] as const;
export type GearstackDebugChannel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Legacy modes are retained for comparison, not used by default. */
export const REMAP_MODES = [
  "legacy range", "legacy scale/bias band lerp", "legacy scale/bias band clamp",
  "authored bias + scale, lower + width (default)",
] as const;
export type RemapMode = 0 | 1 | 2 | 3;
export const DEFAULT_ROUGHNESS_REMAP_MODE: RemapMode = 3;
export const DEFAULT_WEAR_REMAP_MODE: RemapMode = 3;

export interface BandTuning {
  /** below this raw A -> the hardest ranked slot (metal trim) */
  t1: number;
  /** between t1 and t2 -> the middle ranked slot; at/above -> softest (cloth) */
  t2: number;
}

export const BAND_DEFAULTS: BandTuning = { t1: 0.5, t2: 0.625 };

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

export function isPatternGroup(g: GroupInfo): boolean {
  const { noise, ripple } = matchPatternTextureNames(g.patternTextures);
  return !!noise && !!ripple;
}

const PATTERN_TILE_SCALE = 3.0;
const PATTERN_WARP_STRENGTH = 0.35;
const PATTERN_FLOW_SPEED = 0.06;
const PATTERN_SHEEN = 0.38;

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

export const DEFAULT_GLOW_ENABLED = false;

export const BAND_MODES = [
  "3-slot thresholds (t1/t2)",
  "6 bands, slot-major (s0P s0S s1P s1S s2P s2S)",
  "6 bands, parity-major (s0P s1P s2P s0S s1S s2S)",
  "authored material slots (default)",
] as const;
export type BandMode = 0 | 1 | 2 | 3;
// Gearstack A stores wear, not a material ID. Other modes are experiments.
export const DEFAULT_BAND_MODE: BandMode = 3;

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

export function setGlowEnabled(root: THREE.Object3D, enabled: boolean): void {
  forEachGearMaterial(root, (u) => {
    if (u.uGlowEnabled) u.uGlowEnabled.value = enabled ? 1 : 0;
  });
}

export function hasAnimatedGlow(root: THREE.Object3D): boolean {
  let found = false;
  forEachGearMaterial(root, (u) => {
    if (u.uGlowEnabled) found = true;
  });
  return found;
}

export function advanceGlowTime(root: THREE.Object3D, deltaSeconds: number): void {
  forEachGearMaterial(root, (u) => {
    if (u.uGlowTime) u.uGlowTime.value += deltaSeconds;
  });
}

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
  /** D2 reference lookup: x=N.V, y=(index+0.5)/height in top-down PNG rows. */
  iridescenceLookup?: THREE.Texture;
  normal?: THREE.Texture;
  gearstack?: THREE.Texture;
  /** Optional locally reconstructed gearstack; original stays available for comparison. */
  materialBoundaries?: THREE.Texture;
  /** Decoded categorical dye map: R = change-color ID + 1, A = override coverage. */
  dyeslot?: THREE.Texture;
  /** dedicated glow/illum mask (only some items have one) */
  emissive?: THREE.Texture;
  /** Exact-name static effect textures; never sampled through the armor atlas. */
  effectTextures?: Map<string, THREE.Texture>;
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
  /** Compatibility only: plating no longer changes the dye math. */
  plated?: boolean;
  /** Limits the optional legacy band experiment to single-file assets. */
  singlePart?: boolean;
  /** Enables the existing approximate ability VFX preview. */
  animatedGlow?: boolean;

  sourceGeometry?: THREE.BufferGeometry;
}

export function needsBandSplit(groups: GroupInfo[]): boolean {
  const partSlots = new Set(
    groups
      .filter((g) => !g.glow)
      .map((g) => decodeChangeColorIndex(g.dyeIndex).slot),
  );
  return partSlots.size === 1;
}

export function decodeChangeColorIndex(index: number): {
  slot: number;
  useSecondary: boolean;
  decal: boolean;
} {
  if (!Number.isInteger(index) || index < 0 || index > 7) {
    return { slot: -1, useSecondary: false, decal: false };
  }
  const raw = index;
  const slot = raw >> 1;
  return { slot, useSecondary: (raw & 1) === 1, decal: slot === 3 };
}

function makeGlow(maps: GearTextureMaps): THREE.Material {
  // The atlas is shared with shell materials; never change its transfer function
  // based on which geometry group happened to be constructed last.
  if (maps.diffuse) maps.diffuse.colorSpace = THREE.SRGBColorSpace;
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

function makeRayGlow(group: GroupInfo, dyes: DyeSet, maps: GearTextureMaps, hasUV: boolean): THREE.Material {
  const names = matchRayTextureNames(group.patternTextures);
  const height = maps.effectTextures?.get(names.height!);
  const smoke = maps.effectTextures?.get(names.smoke!);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.AdditiveBlending;
  // These assets contain front/back ribbons already. Drawing both faces doubles them.
  mat.side = THREE.FrontSide;
  mat.userData.destiny = { effect: "ray-glow", approximate: true, approximateEffect: true,
    missingTextures: !height || !smoke, missingUV: !hasUV };
  if (!hasUV || !height || !smoke) {
    // Missing effect inputs must never expose the solid carrier polygons.
    mat.visible = false;
    return mat;
  }
  const { slot, useSecondary } = decodeChangeColorIndex(group.dyeIndex);
  const dye = dyeForSlot(dyes, slot);
  const tint = useSecondary ? dye.secondary : dye.primary;
  const clock = uniform(0);
  mat.userData.uniforms = { uPatternTime: clock };
  const local = attribute<"vec2">("effectUv", "vec2");
  const rays = texture(height, vec2(local.y.mul(0.5).sub(clock.mul(0.035)), local.x)).r;
  const wisps = texture(smoke, local.mul(vec2(1, 1.5)).sub(vec2(0, clock.mul(0.08)))).r;
  // Soft longitudinal fade plus a narrow cross-section conceals the carrier edges.
  // Speeds/envelope are preview approximations; textures and emissive tint are authored.
  const across = pow(max(float(1).sub(local.x.sub(0.5).abs().mul(2)), 0), 3);
  const along = pow(clamp(local.y.oneMinus(), 0, 1), 2);
  mat.colorNode = vec3(tint.emissive.r, tint.emissive.g, tint.emissive.b).mul(tint.emissiveIntensity);
  mat.mrtNode = mrt({ emissive: vec4(mat.colorNode, output.a) });
  mat.opacityNode = across.mul(along).mul(rays).mul(wisps).mul(0.85);
  return mat;
}

function makeCloudEffect(group: GroupInfo, dyes: DyeSet, maps: GearTextureMaps, hasUV: boolean): THREE.Material {
  const names = matchCloudTextureNames(group.patternTextures);
  const palette = maps.effectTextures?.get(names.palette!);
  const cloud = maps.effectTextures?.get(names.cloud!);
  const mask = maps.effectTextures?.get(names.mask!);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.blending = THREE.AdditiveBlending;
  mat.userData.destiny = { effect: "digital-cloud", approximateEffect: true,
    coverageSource: "gearstack-blue", missingTextures: !maps.gearstack,
    missingAnimationTextures: !palette || !cloud || !mask };
  if (!maps.gearstack) { mat.visible = false; return mat; }
  const clock = uniform(0);
  mat.userData.uniforms = { uPatternTime: clock };
  // The TWO distinct symbol silhouettes are authored in atlas-space gearstack B.
  // Generic cloud/dust textures are modulation inputs, never their coverage.
  maps.gearstack.colorSpace = THREE.NoColorSpace;
  const symbols = clamp(texture(maps.gearstack, uv()).b.sub(GEARSTACK.emissiveStart).div(1 - GEARSTACK.emissiveStart), 0, 1);
  const local = hasUV ? attribute<"vec2">("effectUv", "vec2") : uv();
  const density = cloud ? texture(cloud, local.add(vec2(clock.mul(0.025), clock.mul(-0.015)))).r : float(0.5);
  const dust = mask ? texture(mask, local).r : float(0);
  const paletteWidth = (palette?.image as { width?: number } | undefined)?.width ?? 128;
  const halfTexel = 0.5 / paletteWidth;
  const paletteValue = palette
    ? texture(palette, vec2(clamp(density, halfTexel, 1 - halfTexel), 0.5)).rgb : vec3(0);
  const { slot, useSecondary } = decodeChangeColorIndex(group.dyeIndex);
  const dye = dyeForSlot(dyes, slot), tint = useSecondary ? dye.secondary : dye.primary;
  // Effect emission is independent of armor dye emission (Spacewalk's is zero).
  // The reference-calibrated program tint is shared by all matching exports.
  const fallback = effectEmissionFallback([group])!;
  const color = tint.emissiveIntensity > 0 && tint.emissive.r + tint.emissive.g + tint.emissive.b > 0
    ? vec3(tint.emissive.r, tint.emissive.g, tint.emissive.b).mul(tint.emissiveIntensity)
    : vec3(...fallback.color).mul(fallback.intensity);
  mat.userData.destiny.emissionFallback = tint.emissiveIntensity > 0 && tint.emissive.r + tint.emissive.g + tint.emissive.b > 0
    ? null : fallback.source;
  mat.colorNode = color.mul(vec3(1).add(paletteValue)).mul(mix(1.25, 1.75, density).add(dust.mul(0.25)));
  mat.mrtNode = mrt({ emissive: vec4(mat.colorNode, output.a) });
  mat.opacityNode = symbols;
  return mat;
}

function unsupportedTransparentEffect(group: GroupInfo): THREE.Material {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.visible = false;
  mat.userData.destiny = { unsupportedEffect: true, renderStage: group.renderStage,
    shaderType: group.shaderType, textures: group.patternTextures ?? [] };
  return mat;
}

const ABILITY_VFX_FLAG = 0x2000;

function isAbilityVfxGroup(g: GroupInfo): boolean {
  return ((g.flags ?? 0) & ABILITY_VFX_FLAG) !== 0;
}

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
  renderStage?: number | null,
  emissionFallback?: EffectEmission,
): THREE.Material {
  const { slot, useSecondary } = decodeChangeColorIndex(dyeIndex);
  const validSlot = slot >= 0 && slot <= 2;
  const slotDye = dyeForSlot(dyes, validSlot ? slot : -1);
  const ownTint: DyeTint = useSecondary ? slotDye.secondary : slotDye.primary;

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
  if (renderStage === 6) {
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
  }

  if (maps.diffuse) maps.diffuse.colorSpace = THREE.SRGBColorSpace;
  if (maps.emissive) maps.emissive.colorSpace = THREE.SRGBColorSpace;
  for (const dataMap of [maps.normal, maps.gearstack, maps.dyeslot, maps.materialBoundaries]) {
    if (dataMap) dataMap.colorSpace = THREE.NoColorSpace;
  }
  const detailDiffuse = slotDye.detailDiffuse ?? null;
  if (detailDiffuse) {
    detailDiffuse.colorSpace = THREE.SRGBColorSpace;
    detailDiffuse.wrapS = detailDiffuse.wrapT = THREE.RepeatWrapping;
  }

  const wantGearstack = !!opts.useGearstack && !!maps.gearstack && !!maps.diffuse;
  const wantDetail = Object.values(dyes).some((d) => d.detailDiffuse || d.detailNormal) && !!maps.diffuse;

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

  const ROWS_PER_MATERIAL = 9;
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
        new THREE.Vector4(t.detailNormalBlend, t.detailRoughnessBlend, t.transmission, t.wornDetailBlend),
        new THREE.Vector4(t.wornDetailNormalBlend, t.wornDetailRoughnessBlend, 0, 0),
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
  // GDC 2018 slide 121 assigns the full R range to texture AO.
  const ao = gs.r;
  // Alpha packs distinct material classes. Mip/bilinear interpolation can turn
  // an undyed dielectric next to cloth into metal or dyed cloth. Read the same
  // exact texel for dye eligibility, undyed metalness and wear classification.
  const materialMap = maps.materialBoundaries ?? maps.gearstack;
  const gsImage = materialMap?.image as { width?: number; height?: number } | undefined;
  const gsSize = vec2(gsImage?.width ?? 1, gsImage?.height ?? 1);
  const gsMaterial = wantGearstack
    ? textureLoad(materialMap!, ivec2(clamp(floor(uvN.mul(gsSize)), vec2(0), vec2(gsSize).sub(1))), int(0))
    : gs;
  const gsSharpA = gsMaterial.a;
  // Reconstructed G/B share alpha's boundary. Filtering the original G/B
  // independently would reintroduce gloss/emission from the other material.
  const smoothRaw = maps.materialBoundaries ? gsMaterial.g : gs.g;
  const dyeMask = step(GEARSTACK.dyeThreshold, gsSharpA);
  const undyedMetal = clamp(gsSharpA.mul(255 / 32), 0.0, 1.0);
  const wearRaw = clamp(gsSharpA.sub(48 / 255).mul(255 / (255 - 48)), 0.0, 1.0);
  // B channel (per the documented ranges, verified against live plates where
  // ~95% of texels anchor at 32/255): alpha-test cut-outs occupy 0..32,
  // emissive 40..255, mutually exclusive. NOT a 128 midpoint.
  const emissiveMask = clamp(gsMaterial.b.sub(40 / 255).mul(255 / (255 - 40)), 0.0, 1.0);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  type TSLNode = any;
  const ranked = rankSlotsSoftToHard(dyes);
  const partParity = float(useSecondary ? 1.0 : 0.0);
  let slotF: TSLNode;
  let parityF: TSLNode = partParity;

  const oneHotSlot = (s: TSLNode): TSLNode => {
    const c = clamp(s, 0.0, 2.0);
    return vec3(
      select(c.lessThan(0.5), 1.0, 0.0),
      select(c.greaterThanEqual(0.5).and(c.lessThan(1.5)), 1.0, 0.0),
      select(c.greaterThanEqual(1.5), 1.0, 0.0),
    );
  };

  let bandSlotF: TSLNode | null = null;
  let bandParityF: TSLNode | null = null;
  if (bandSplit && ranked.length >= 2 && validSlot) {
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

  // Geometry IDs are the baseline; legacy alpha experiments only affect that
  // fallback. An authored dye map takes precedence in every mode.
  slotF = bandSlotF ?? float(validSlot ? slot : -1);
  parityF = bandParityF ?? partParity;
  slotF = select(uBandMode.greaterThan(2.5), float(validSlot ? slot : -1), slotF);
  parityF = select(uBandMode.greaterThan(2.5), partParity, parityF);
  if (maps.dyeslot && validSlot) {
    // Loader decodes categorical RGB to ID+1 in R. Never blend IDs or use RGB
    // as material weights. Alpha marks coverage; black source pixels inherit.
    const image = maps.dyeslot.image as { width?: number; height?: number } | undefined;
    const size = vec2(image?.width ?? 1, image?.height ?? 1);
    const dye = textureLoad(maps.dyeslot,
      ivec2(clamp(floor(uvN.mul(size)), vec2(0), size.sub(1))), int(0));
    const id = floor(dye.r.mul(255).add(0.5)).sub(1);
    const active = dye.a.greaterThan(0.5).and(id.greaterThanEqual(0)).and(id.lessThan(6));
    const mapSlot = floor(id.mul(0.5));
    slotF = select(active, mapSlot, slotF);
    parityF = select(active, id.sub(mapSlot.mul(2)), parityF);
  }
  const slotWeights = oneHotSlot(slotF);
  const dyeOn = !!opts.applyDye && wantGearstack;
  const resolvedDyeAvailable = dot(slotWeights, vec3(dyes[0] ? 1 : 0, dyes[1] ? 1 : 0, dyes[2] ? 1 : 0));
  const slotAvailable = validSlot ? resolvedDyeAvailable : float(0);
  const isDyed = dyeOn ? step(-0.5, slotF).mul(dyeMask).mul(slotAvailable) : float(0.0);

  // Per-(slot, parity) lookup into the packed material table: material index =
  // parity*3 + slot, row offset per the layout above. uniformArray elements
  // are untyped for TS, hence the cast.
  const slotRounded = floor(clamp(slotF, 0.0, 2.0).add(0.5));
  const matRowAt = (slotIndex: TSLNode, row: number) =>
    vec4(
      uMaterialTable.element(
        int(
          parityF
            .mul(3.0)
            .add(slotIndex)
            .mul(ROWS_PER_MATERIAL)
            .add(row + 0.5),
        ),
      ) as TSLNode,
    );

  const matRow = (row: number) =>
    matRowAt(float(0.0), row)
      .mul(slotWeights.x)
      .add(matRowAt(float(1.0), row).mul(slotWeights.y))
      .add(matRowAt(float(2.0), row).mul(slotWeights.z));

  /** Row from the single dominant slot — for values that must not interpolate. */
  const matRowDominant = (row: number) => matRowAt(slotRounded, row);

  const applyRemap = (raw: TSLNode, r: TSLNode, modeUniform: TSLNode) => {
    const tRange = clamp(raw.sub(r.x).div(max(r.y.sub(r.x), 1e-5)), 0.0, 1.0);
    const range = mix(r.z, r.w, tRange);
    const tBias = clamp(raw.mul(r.x).add(r.y), 0.0, 1.0);
    const lerpBand = mix(r.z, r.w, tBias);
    const clampBand = clamp(raw.mul(r.x).add(r.y), min(r.z, r.w), max(r.z, r.w));
    const authored = authoredRemap(raw, r.x, r.y, r.z, r.w, {
      add: (a: TSLNode, b: TSLNode) => a.add(b),
      mul: (a: TSLNode, b: TSLNode) => a.mul(b),
      clamp: (a: TSLNode, lo: TSLNode, hi: TSLNode) => clamp(a, lo, hi),
    });
    return select(modeUniform.greaterThan(2.5), authored, select(
      modeUniform.lessThan(0.5),
      range,
      select(modeUniform.lessThan(1.5), lerpBand, clampBand),
    ));
  };

  // Authored remap returns the surviving coating: 1 = pristine, 0 = worn.
  // [0,0,1,0] is the common explicit no-wear remap.
  const wearMapped = clamp(applyRemap(wearRaw, matRow(4), uWearRemapMode), 0.0, 1.0);
  const wearAmt = select(uWearRemapMode.greaterThan(2.5), wearMapped.oneMinus(), wearMapped).mul(isDyed);
  const detailDiffuseBlend = mix(matRow(6).y, matRow(7).w, wearAmt).mul(isDyed);
  const detailNormalBlend = mix(matRow(7).x, matRow(8).x, wearAmt).mul(isDyed);
  const detailRoughnessBlend = mix(matRow(7).y, matRow(8).y, wearAmt).mul(isDyed);

  // Texture and transform must follow the same resolved slot as the parameters.
  let detailColor: TSLNode = vec3(0.0);
  let detailGloss: TSLNode = float(0.0);
  let detailNormalXY: TSLNode = vec2(0.0);
  const detailUv = opts.sourceGeometry?.hasAttribute("uv1") ? uv(1) : uvN;
  for (let i = 0; i < 3; i++) {
    const d = dyeForSlot(dyes, i);
    const weight = i === 0 ? slotWeights.x : i === 1 ? slotWeights.y : slotWeights.z;
    // The mobile blend has a neutral detail pivot at 0.25 linear.
    let sample: TSLNode = vec4(0.25, 0.25, 0.25, 0.25);
    if (d.detailDiffuse) {
      // Decode RGB once; texture alpha remains linear roughness data.
      d.detailDiffuse.colorSpace = THREE.SRGBColorSpace;
      d.detailDiffuse.wrapS = d.detailDiffuse.wrapT = THREE.RepeatWrapping;
      const t = d.detailDiffuseTransform;
      sample = texture(d.detailDiffuse, detailUv.mul(vec2(t[0], t[1])).add(vec2(t[2], t[3])));
    }
    detailColor = detailColor.add(sample.rgb.mul(weight));
    detailGloss = detailGloss.add(sample.a.mul(weight));
    if (d.detailNormal) {
      d.detailNormal.colorSpace = THREE.NoColorSpace;
      d.detailNormal.wrapS = d.detailNormal.wrapT = THREE.RepeatWrapping;
      const t = d.detailNormalTransform;
      const n = texture(d.detailNormal, detailUv.mul(vec2(t[0], t[1])).add(vec2(t[2], t[3])));
      detailNormalXY = detailNormalXY.add(n.xy.mul(2.0).sub(1.0).mul(weight));
    }
  }

  const albedo = maps.diffuse ? texture(maps.diffuse, uvN).rgb : vec3(1.0);
  const wearTint = mix(matRow(0).xyz, matRow(1).xyz, wearAmt);
  // Use the gearstack mask, never diffuse saturation/brightness, to gate dye.
  const overlayColor = wearTint.mul(clamp(albedo.mul(4.0), 0.0, 1.0))
    .add(clamp(albedo.sub(0.25), 0.0, 1.0));
  let dyedColor = mix(albedo, overlayColor, isDyed);
  const detailedColor = dyedColor.mul(clamp(detailColor.mul(4.0), 0.0, 1.0))
    .add(clamp(detailColor.sub(0.25), 0.0, 1.0));
  dyedColor = mix(dyedColor, detailedColor, detailDiffuseBlend);

  // D2's artist-authored specular palette is not a physical film thickness.
  const iridescenceIds = [...new Set([...prims, ...secs].map((t) => t.materialTypeId).filter((id) => id >= 0))];
  mat.userData.destiny = {
    model: "d2-mobile-mastife", iridescenceIds,
    missingIridescenceLookup: iridescenceIds.length > 0 && !maps.iridescenceLookup,
    approximateEffects: [pattern ? "pattern shimmer" : null, accent ? "darkness" : null].filter(Boolean),
    slotSource: "stage-part",
    boundaryReconstruction: maps.materialBoundaries?.userData.materialBoundaries ?? null,
  };
  let iridescentMetalAmount: TSLNode = float(0);
  if (maps.iridescenceLookup && iridescenceIds.length) {
    const id = matRowDominant(6).w;
    const height = (maps.iridescenceLookup.image as { height?: number } | undefined)?.height ?? 128;
    const facing = clamp(dot(normalView, positionViewDirection), 0.0, 1.0);
    const palette = texture(maps.iridescenceLookup, vec2(facing, id.add(0.5).div(height)));
    const active = select(id.greaterThanEqual(0).and(id.lessThan(height)).and(palette.a.greaterThan(0)), isDyed, float(0));
    const amount = clamp(float(1).sub(dot(wearTint, vec3(0.2126, 0.7152, 0.0722))), 0, 1).mul(active);
    const metallicPalette = id.mod(2).equal(0);
    iridescentMetalAmount = select(metallicPalette, amount, float(0));
    // Reference even IDs use a metallic color palette; odd IDs tint dielectric
    // specular. Palette alpha attenuates the coating independently of RGB.
    dyedColor = mix(dyedColor.mul(mix(1, palette.a, active)), palette.rgb, iridescentMetalAmount);
    mat.specularColorNode = mix(vec3(1.0), palette.rgb, select(metallicPalette, float(0), amount));
  }

  const wantsPattern = pattern && !!maps.patternNoise && !!maps.patternRipple;
  const wantsAccent =
    accent && !!maps.accentTwirl && !!maps.accentBlob && !!maps.accentDarkness;
  const uPatternTime = wantsPattern || wantsAccent ? uniform(0) : null;
  if (uPatternTime) {
    mat.userData.uniforms = { ...mat.userData.uniforms, uPatternTime };
  }

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
      clamp(dot(normalView, positionViewDirection), 0.0, 1.0).oneMinus(),
      3.0,
    );
    const colorMix = clamp(fresnel.mul(0.85).add(noiseSample.mul(0.35)), 0.0, 1.0);
    const iridescentWhite = vec3(0.9, 0.93, 1.0);
    const iridescentBlue = vec3(0.3, 0.46, 1.0);
    const iridescentPurple = vec3(0.5, 0.28, 0.98);
    const iridescentMagenta = vec3(0.88, 0.36, 0.9);
    const lowMix = mix(iridescentWhite, iridescentBlue, smoothstep(0.0, 0.4, colorMix));
    const midMix = mix(lowMix, iridescentPurple, smoothstep(0.4, 0.72, colorMix));
    const iridescentTint = mix(midMix, iridescentMagenta, smoothstep(0.72, 1.0, colorMix));
    const baseLum = luminance(dyedColor);
    const shimmerDesat = smoothstep(0.45, 0.8, baseLum).mul(0.82);
    const shimmerTint = mix(iridescentTint, vec3(1.0, 1.0, 1.0), shimmerDesat);
    const shimmered = dyedColor.mul(shimmerTint).mul(1.25);
    dyedColor = mix(dyedColor, shimmered, PATTERN_SHEEN);
  }

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
    const detailSmooth = detailGloss.mul(clamp(smoothRaw.mul(4.0), 0.0, 1.0))
      .add(clamp(smoothRaw.sub(0.25), 0.0, 1.0));
    const smoothInput = mix(smoothRaw, detailSmooth, detailRoughnessBlend);
    const smoothBase = applyRemap(smoothInput, matRow(2), uRoughnessRemapMode);
    const smoothWorn = applyRemap(smoothInput, matRow(3), uRoughnessRemapMode);
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
    const resolvedMetal = mix(undyedMetal, metalDyed, isDyed);
    mat.metalnessNode = mix(resolvedMetal, 1, iridescentMetalAmount);

    // ---- AO --------------------------------------------------------------------
    mat.aoNode = ao;

    // ---- fuzz -> sheen (Disney: an extra Fresnel-shaped grazing lobe, tinted
    // toward the base colour), driven by the dye's authored fuzz amount plus any
    // negative-smoothness fuzz from the remap.
    const anyFuzz =
      prims.some((t) => t.fuzz > 0) ||
      secs.some((t) => t.fuzz > 0) ||
      [...prims, ...secs].some((t) => t.roughnessRemap[2] < 0 || t.wornRoughnessRemap[2] < 0);
    if (anyFuzz) {
      const fuzzAmt = clamp(
        matRow(6).x.add(fuzzFromNegativeSmoothness),
        0.0,
        1.0,
      ).mul(isDyed);
      mat.sheenNode = dyedColor.mul(fuzzAmt);
      mat.sheenRoughnessNode = float(0.9);
    }

    // Emission is independent of the iridescence index and tint repetition.
    const em = matRow(5);
    let emissionColor = em.xyz.mul(em.w);
    if (emissionFallback) {
      // Some programs drive BOTH projected symbols and tiny shell lamps with
      // an unexported constant. B remains the sole coverage; no albedo guessing.
      const fallback = vec3(...emissionFallback.color).mul(emissionFallback.intensity);
      emissionColor = select(dot(emissionColor, vec3(1)).greaterThan(0), emissionColor, fallback);
      mat.userData.destiny.emissionFallback = emissionFallback.source;
    }
    let emissive = emissionColor.mul(emissiveMask).mul(slotAvailable);
    if (maps.emissive) {
      emissive = emissive.add(texture(maps.emissive, uvN).rgb);
    }
    if (uGlowEnabled && uGlowTime) {
      const flicker = sin(uGlowTime.mul(5.0)).mul(0.5).add(0.5);
      emissive = emissive.mul(mix(0.55, 1.0, flicker)).mul(uGlowEnabled);
    }
    mat.emissiveNode = emissive;

    // ---- subsurface scattering (Bungie: wrapped diffuse + inverted view-
    // dependent lobe; three's SSS node material implements the same family of
    // approximation). Enabled only when the dye ships a strength.
    if ([...prims, ...secs].some((t) => t.transmission > 0 || t.sss > 0)) {
      const sssStrength = clamp(max(matRow(7).z, matRow(6).z.div(50)), 0.0, 1.0).mul(isDyed);
      mat.thicknessColorNode = dyedColor.mul(sssStrength).mul(mix(undyedMetal, metalDyed, isDyed).oneMinus());
      mat.thicknessDistortionNode = float(0.1);
      mat.thicknessAttenuationNode = float(0.8);
      mat.thicknessPowerNode = float(2.0);
      mat.thicknessScaleNode = float(4.0);
    }

    const slotColor = select(
      isDyed.lessThan(0.5),
      vec3(0.15, 0.15, 0.15),
      slotWeights.mul(parityF.mul(-0.5).add(1.0)),
    );
    // Channel 6: visualize the wear range as eight hues for legacy comparisons.
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
    const decodedAlpha = vec3(undyedMetal.mul(dyeMask.oneMinus()), dyeMask, wearRaw.mul(dyeMask));
    const originalSize = maps.gearstack!.image as { width?: number; height?: number } | undefined;
    const originalDimensions = vec2(originalSize?.width ?? 1, originalSize?.height ?? 1);
    const originalAlpha = textureLoad(maps.gearstack!,
      ivec2(clamp(floor(uvN.mul(originalDimensions)), vec2(0), originalDimensions.sub(1))), int(0)).a;
    const alphaClass = (a: TSLNode) => step(8.5 / 255, a).add(step(23.5 / 255, a)).add(step(39.5 / 255, a));
    const estimatedBoundary = select(alphaClass(originalAlpha).notEqual(alphaClass(gsSharpA)),
      vec3(1, 0.8, 0), vec3(0.08));
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
            select(uDebugChannel.lessThan(5.5), slotColor,
              select(uDebugChannel.lessThan(6.5), bandColor,
                select(uDebugChannel.lessThan(7.5), vec3(resolvedMetal),
                  select(uDebugChannel.lessThan(8.5), decodedAlpha, estimatedBoundary)))),
          ),
        ),
      ),
    );
    const dbgOut = sRGBTransferEOTF(dbg) as TSLNode;
    mat.outputNode = select(uDebugChannel.greaterThan(0.5), vec4(dbgOut, 1.0), output);
  }

  // Normal maps encode XY; reconstruct Z instead of using the cavity channel.
  if (maps.normal || Object.values(dyes).some((d) => d.detailNormal)) {
    const baseXY = vec2(maps.normal ? texture(maps.normal, uvN).xy.mul(2.0).sub(1.0) : vec2(0.0));
    const detailXY = detailNormalXY.mul(detailNormalBlend);
    const baseZ = sqrt(max(float(1.0).sub(dot(baseXY, baseXY)), 1e-5));
    const detailZ = sqrt(max(float(1.0).sub(dot(detailXY, detailXY)), 1e-5));
    const combined = vec3(baseXY.x.add(detailXY.x), baseXY.y.add(detailXY.y), baseZ.mul(detailZ)).normalize();
    mat.normalNode = normalMap(combined.mul(0.5).add(0.5));
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
  const bandSplit =
    ((opts.singlePart ?? true) || !!maps.dyeslot) && needsBandSplit(groups);
  const hasVfxGroups = !!opts.animatedGlow && groups.some(isAbilityVfxGroup);
  const hasRadialGradient =
    hasVfxGroups && !!opts.sourceGeometry && ensureVfxRadialAttribute(opts.sourceGeometry, groups);
  const hasEffectUV = !!opts.sourceGeometry && prepareEffectUVs(opts.sourceGeometry, groups);
  const emissionFallback = effectEmissionFallback(groups);
  return groups.map((g) => {
    if (isRayGlowGroup(g)) return makeRayGlow(g, dyes, maps, hasEffectUV);
    if (transparentEffect(g)?.kind === "digital-cloud") return makeCloudEffect(g, dyes, maps, hasEffectUV);
    if (g.glow) return makeGlow(maps);
    if (opts.animatedGlow && isAbilityVfxGroup(g)) {
      return makeAbilityVfxGeometry(g.dyeIndex, dyes, hasRadialGradient);
    }
    // All transparent passes must leave the opaque-armor path, even when their
    // effect program is unknown. Keep a diagnostic instead of solid carrier cards.
    if (g.renderStage === 7) return unsupportedTransparentEffect(g);
    const material = makeOpaque(
      g.dyeIndex,
      dyes,
      maps,
      opts,
      g.decal,
      bandSplit,
      isPatternGroup(g),
      isAccentGroup(g),
      g.renderStage,
      emissionFallback,
    );
    material.userData.destiny = {
      ...material.userData.destiny,
      slotSource: maps.dyeslot && decodeChangeColorIndex(g.dyeIndex).slot < 3 && g.dyeIndex >= 0
        ? "dye-map" : g.dyeSource ?? "stage-part",
      geometrySlotSource: g.dyeSource ?? "stage-part",
    };
    return material;
  });
}

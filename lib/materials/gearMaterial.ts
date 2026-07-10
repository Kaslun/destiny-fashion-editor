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
 * A per-pixel dyeslot plate (R = 1-based slot id), when the item ships one,
 * refines the slot per texel; the parity (primary vs secondary) stays with
 * the stage part.
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
 * interpretation is a LIVE-SWITCHABLE uniform (see REMAP_MODES /
 * setRemapMode) rather than a baked-in guess:
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
export const DEFAULT_REMAP_MODE: RemapMode = 0;

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
 * How the A channel resolves per-pixel materials on single-slot meshes.
 * Bungie's material set is 3 dye slots x primary/secondary = 6 materials per
 * item (the TFS shader-icon rework shows all six colours per shader), so the
 * 6-band modes cut the dyeable range (48..255) into six equal (slot, parity)
 * bands. The band→pair ordering isn't publicly documented, so both orderings
 * are live-switchable; mode 0 keeps the hand-tunable 3-slot threshold split.
 */
export const BAND_MODES = [
  "3-slot thresholds (t1/t2)",
  "6 bands, slot-major (s0P s0S s1P s1S s2P s2S)",
  "6 bands, parity-major (s0P s1P s2P s0S s1S s2S)",
] as const;
export type BandMode = 0 | 1 | 2;
export const DEFAULT_BAND_MODE: BandMode = 2;

interface GearUniforms {
  uDebugChannel?: { value: number };
  uRemapMode?: { value: number };
  uBandMode?: { value: number };
  uBandT1?: { value: number };
  uBandT2?: { value: number };
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

/** Switch the remap-vec4 interpretation live on every material under `root`. */
export function setRemapMode(root: THREE.Object3D, mode: RemapMode): void {
  forEachGearMaterial(root, (u) => {
    if (u.uRemapMode) u.uRemapMode.value = mode;
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
  /** per-pixel dye-slot mask plate (R = 1-based slot id, 0 = baked art) */
  dyeslot?: THREE.Texture;
  /** dedicated glow/illum mask (only some items have one) */
  emissive?: THREE.Texture;
}

export interface GearMaterialOptions {
  /** Apply gearstack AO + smoothness to the PBR response. */
  useGearstack?: boolean;
  /** Tint the albedo with the resolved dye colours. */
  applyDye?: boolean;
  /**
   * True for plate-based armor: its diffuse is greyscale detail, so the dye
   * fully colours it (brighten + tint). False for weapons/items with a baked
   * colour diffuse, where the dye only tints the masked trim and the painted
   * body is preserved.
   */
  plated?: boolean;
}

/**
 * Whether a mesh needs the per-pixel A-channel band split: it only applies
 * when the mesh gives us NO per-part slot variation to work with (every
 * non-glow stage part decodes to the same slot) and no per-pixel dyeslot
 * plate exists. Meshes with real per-part slots (e.g. Nighthawk) keep their
 * authored data untouched.
 */
export function needsBandSplit(groups: GroupInfo[], hasDyeslot: boolean): boolean {
  if (hasDyeslot) return false;
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

function makeOpaque(
  dyeIndex: number,
  dyes: DyeSet,
  maps: GearTextureMaps,
  opts: GearMaterialOptions,
  overlay = false,
  bandSplit = false,
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
  const uRemapMode = uniform(DEFAULT_REMAP_MODE as number);
  const uBandMode = uniform(DEFAULT_BAND_MODE as number);
  const uBandT1 = uniform(BAND_DEFAULTS.t1);
  const uBandT2 = uniform(BAND_DEFAULTS.t2);
  mat.userData.uniforms = { uDebugChannel, uRemapMode, uBandMode, uBandT1, uBandT2 };

  // ---- per-(slot, parity) parameter table -------------------------------------
  // All 6 materials (3 slots × 2 tints) packed into ONE uniform vec4 array —
  // WebGPU caps uniform buffers at 12 per stage, so one binding with computed
  // indexing instead of one uniformArray per parameter. Layout per material
  // (ROWS_PER_MATERIAL rows): 0 albedo.rgb+metalness · 1 wornAlbedo.rgb+worn-
  // metalness · 2 roughnessRemap · 3 wornRoughnessRemap · 4 wearRemap ·
  // 5 emissive.rgb+intensity · 6 fuzz,detailBlend,sss,unused.
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
        new THREE.Vector4(t.fuzz, t.detailBlend, t.sss, 0),
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
  const ao = gs.r;
  const smoothRaw = gs.g;
  const dyeMask = step(40 / 255, gs.a);
  const undyedMetal = clamp(gs.a.mul(255 / 32), 0.0, 1.0);
  const wearRaw = clamp(gs.a.sub(48 / 255).mul(255 / (255 - 48)), 0.0, 1.0);
  // B channel (per the documented ranges, verified against live plates where
  // ~95% of texels anchor at 32/255): alpha-test cut-outs occupy 0..32,
  // emissive 40..255, mutually exclusive. NOT a 128 midpoint.
  const emissiveMask = clamp(gs.b.sub(40 / 255).mul(255 / (255 - 40)), 0.0, 1.0);

  // ---- dye slot + tint-parity resolution ---------------------------------------
  // Per-pixel dyeslot plate when present (R = 1-based slot id, 0 = baked art);
  // else — for meshes whose stage parts all share ONE slot (e.g. Cover of the
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
  if (maps.dyeslot) {
    const q = floor(texture(maps.dyeslot, uvN).r.mul(3.0).add(0.5));
    slotF = q.sub(1.0); // 0 -> -1 (baked), 1..3 -> slot 0..2
  } else if (bandSplit && ranked.length >= 2 && !decalSlot) {
    // mode 0 — ranked-slot thresholds on raw A (ascending = softer material)
    const soft = float(ranked[0]);
    const hard = float(ranked[ranked.length - 1]);
    const midBand =
      ranked.length >= 3
        ? select(gs.a.lessThan(uBandT2), float(ranked[1]), soft)
        : soft;
    const slot3 = select(gs.a.lessThan(uBandT1), hard, midBand);
    // 6 equal bands across the dyeable range
    const w = clamp(gs.a.sub(48 / 255).mul(255 / (255 - 48)), 0.0, 1.0);
    const band6 = clamp(floor(w.mul(6.0)), 0.0, 5.0);
    // mode 1 — slot-major: s0P s0S s1P s1S s2P s2S
    const si1 = floor(band6.mul(0.5));
    const par1 = band6.sub(si1.mul(2.0));
    // mode 2 — parity-major: s0P s1P s2P s0S s1S s2S
    const par2 = floor(band6.div(3.0));
    const si2 = band6.sub(par2.mul(3.0));
    slotF = select(
      uBandMode.lessThan(0.5),
      slot3,
      select(uBandMode.lessThan(1.5), si1, si2),
    );
    parityF = select(
      uBandMode.lessThan(0.5),
      partParity,
      select(uBandMode.lessThan(1.5), par1, par2),
    );
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

  // ---- remap (interpretation switchable at runtime — see REMAP_MODES) --------
  const applyRemap = (raw: TSLNode, r: TSLNode) => {
    const tRange = clamp(raw.sub(r.x).div(max(r.y.sub(r.x), 1e-5)), 0.0, 1.0);
    const range = mix(r.z, r.w, tRange);
    const tBias = clamp(raw.mul(r.x).add(r.y), 0.0, 1.0);
    const lerpBand = mix(r.z, r.w, tBias);
    const clampBand = clamp(raw.mul(r.x).add(r.y), min(r.z, r.w), max(r.z, r.w));
    return select(
      uRemapMode.lessThan(0.5),
      range,
      select(uRemapMode.lessThan(1.5), lerpBand, clampBand),
    );
  };

  const wearAmt = clamp(applyRemap(wearRaw, matRow(4)), 0.0, 1.0).mul(isDyed);

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
  let dyedColor;
  if (opts.plated) {
    // Brightness/saturation gate for baked-colour art, measured on the RAW
    // albedo BEFORE AO darkening — near-grey texels take the tint, saturated
    // or bright texels (painted emblems, white panels) pass through.
    const lum = luminance(albedo);
    const sat = max(albedo.r, max(albedo.g, albedo.b)).sub(
      min(albedo.r, min(albedo.g, albedo.b)),
    );
    const greyMask = smoothstep(0.06, 0.16, sat)
      .oneMinus()
      .mul(smoothstep(0.3, 0.48, lum).oneMinus())
      .mul(smoothstep(0.04, 0.11, lum));
    const m = isDyed.mul(greyMask);
    dyedColor = mix(albedo, clamp(albedo.mul(1.7), 0.0, 1.1).mul(tintN), m);
    dyedColor = mix(dyedColor, dyedColor.mul(wornN), wearAmt.mul(m));
  } else {
    dyedColor = mix(albedo, albedo.mul(tintN), isDyed);
    dyedColor = mix(dyedColor, dyedColor.mul(wornN), wearAmt.mul(isDyed));
  }
  mat.colorNode = vec4(dyedColor, 1.0);

  if (wantGearstack) {
    // ---- smoothness -> roughness (signed domain: negative smoothness = fuzz) --
    const smoothBase = applyRemap(smoothRaw, matRow(2));
    const smoothWorn = applyRemap(smoothRaw, matRow(3));
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
    const em = matRow(5);
    let emissive = em.xyz.mul(em.w).mul(emissiveMask).mul(1.25);
    if (maps.emissive) {
      emissive = emissive.add(texture(maps.emissive, uvN).rgb.mul(1.5));
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
  const bandSplit = needsBandSplit(groups, !!maps.dyeslot);
  return groups.map((g) =>
    g.glow
      ? makeGlow(maps)
      : makeOpaque(g.dyeIndex, dyes, maps, opts, g.decal, bandSplit),
  );
}

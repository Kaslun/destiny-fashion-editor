import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import {
  createGearMaterials,
  decodeChangeColorIndex,
  needsBandSplit,
  setGearstackDebugChannel,
  setRoughnessRemapMode,
  setWearRemapMode,
  setBandThresholds,
  setBandMode,
  setGlowEnabled,
  advanceGlowTime,
  hasAnimatedGlow,
  advancePatternTime,
  matchPatternTextureNames,
  isPatternGroup,
  matchAccentTextureNames,
  isAccentGroup,
  BAND_DEFAULTS,
  BAND_MODES,
  DEFAULT_BAND_MODE,
  DEFAULT_GLOW_ENABLED,
  GEARSTACK_CHANNELS,
  REMAP_MODES,
  DEFAULT_ROUGHNESS_REMAP_MODE,
  DEFAULT_WEAR_REMAP_MODE,
} from "./gearMaterial";
import { dyeSetFromGearDyes } from "./gearDye";
import type { DyeSet } from "./gearDye";
import type { GroupInfo } from "@/lib/geometry/buildGeometry";
import sage from "./fixtures/sage-protector-dyes.json";
import { parseDyes } from "../bungie/parseGearDyes";
import { GearNodeMaterial } from "./gearNodeMaterial";

const noDyes: DyeSet = {};
const tex = () => new THREE.Texture();

describe("reference iridescence palette", () => {
  it("keeps Sage Protector's ordinary fabric independent of its shared VFX resources", () => {
    const dyes = dyeSetFromGearDyes(parseDyes(sage.defaultDyes));
    expect(dyes[1].primary.metalness).toBe(0);
    expect(dyes[1].secondary.metalness).toBe(0);
    const [material] = createGearMaterials([{ dyeIndex: 2, decal: false, shaderType: 7,
      patternTextures: ["1031021746_vfx_energy_fracture_illum", "2503085780_smoke_detail_warp"] }],
    dyes, { diffuse: tex(), gearstack: tex() }, { useGearstack: true, applyDye: true });
    expect(material.userData.destiny.iridescenceIds).toEqual([]);
    expect(material.userData.destiny.approximateEffects).toEqual([]);
    expect(material.userData.destiny.emissionFallback).toBeUndefined();
    expect(material.userData.uniforms.uPatternTime).toBeUndefined();
  });
  it.each([0, 1, 10])("connects valid palette row %i including row zero", (materialTypeId) => {
    const dyes = dyeSetFromGearDyes({ "0": { primary: { materialTypeId } } });
    const groups: GroupInfo[] = [{ dyeIndex: 0, decal: false }];
    const [fallback] = createGearMaterials(groups, dyes, { diffuse: tex(), gearstack: tex() }, { useGearstack: true, applyDye: true });
    expect(fallback.userData.destiny.missingIridescenceLookup).toBe(true);
    const [material] = createGearMaterials(groups, dyes, { diffuse: tex(), gearstack: tex(), iridescenceLookup: tex() }, { useGearstack: true, applyDye: true });
    expect(material.userData.destiny.missingIridescenceLookup).toBe(false);
    expect(material.userData.destiny.iridescenceIds).toContain(materialTypeId);
    expect((material as GearNodeMaterial).paletteSpecularNode).toBeTruthy();
    expect((material as GearNodeMaterial).paletteSpecularAmountNode).toBeTruthy();
    expect((material as THREE.MeshPhysicalNodeMaterial).metalnessNode).toBeTruthy();
  });
  it("does not classify ordinary materials as iridescent", () => {
    const [material] = createGearMaterials([{ dyeIndex: 0, decal: false }], noDyes, { diffuse: tex(), gearstack: tex() }, { useGearstack: true, applyDye: true });
    expect(material.userData.destiny.iridescenceIds).toEqual([]);
    expect(material.userData.destiny.missingIridescenceLookup).toBe(false);
  });
});

function twoSlotDyes(): DyeSet {
  return dyeSetFromGearDyes({
    "0": {
      cloth: false,
      primary: { albedo: [1, 0.62, 0.2], metalness: 1 },
      secondary: { albedo: [0.04, 0.04, 0.04], metalness: 0 },
    },
    "1": {
      cloth: true,
      primary: { albedo: [0.05, 0.28, 0.29], metalness: 0, fuzz: 0.5 },
      secondary: { albedo: [0.53, 0.53, 0.53], metalness: 0 },
    },
  });
}

describe("decodeChangeColorIndex — stage-part encoding (slot << 1 | parity)", () => {
  it("maps (slot << 1) | parity: 0/1 -> slot 0, 2/3 -> slot 1, 4/5 -> slot 2 — even index is PRIMARY, odd is SECONDARY", () => {
    // Verified against the verbatim source (lowlines/destiny-tgx-loader,
    // three.tgxloader.js parseStagePart): usePrimaryColor starts true, set
    // false only on odd cases.
    expect(decodeChangeColorIndex(0)).toEqual({ slot: 0, useSecondary: false, decal: false });
    expect(decodeChangeColorIndex(1)).toEqual({ slot: 0, useSecondary: true, decal: false });
    expect(decodeChangeColorIndex(2)).toEqual({ slot: 1, useSecondary: false, decal: false });
    expect(decodeChangeColorIndex(3)).toEqual({ slot: 1, useSecondary: true, decal: false });
    expect(decodeChangeColorIndex(4)).toEqual({ slot: 2, useSecondary: false, decal: false });
    expect(decodeChangeColorIndex(5)).toEqual({ slot: 2, useSecondary: true, decal: false });
  });

  it("indices 6/7 are the investment-decal slot (3) — never recoloured", () => {
    expect(decodeChangeColorIndex(6)).toEqual({ slot: 3, useSecondary: false, decal: true });
    expect(decodeChangeColorIndex(7)).toEqual({ slot: 3, useSecondary: true, decal: true });
  });

  it("invalid indices stay unassigned rather than inheriting another material", () => {
    for (const index of [-1, 99, 0.5, NaN, Infinity]) {
      expect(decodeChangeColorIndex(index)).toEqual({ slot: -1, useSecondary: false, decal: false });
    }
  });
});

describe("createGearMaterials — material class & decal handling", () => {
  it("uses additive blending only for the authored additive-decal stage", () => {
    const mats = createGearMaterials([
      { dyeIndex: 0, decal: false, flags: 8, renderStage: 0 },
      { dyeIndex: 6, decal: true, renderStage: 6 },
    ], noDyes);
    expect(mats[0].transparent).toBe(false);
    expect(mats[0].blending).toBe(THREE.NormalBlending);
    expect(mats[1].transparent).toBe(true);
    expect(mats[1].depthWrite).toBe(false);
    expect(mats[1].blending).toBe(THREE.AdditiveBlending);
  });
  it("builds node materials (WebGPU/TSL), one per group", () => {
    const groups: GroupInfo[] = [
      { dyeIndex: 0, decal: false },
      { dyeIndex: 5, decal: true },
    ];
    const mats = createGearMaterials(groups, noDyes, {}, {});
    expect(mats).toHaveLength(2);
    expect((mats[0] as THREE.MeshSSSNodeMaterial).isNodeMaterial).toBe(true);
    expect(mats[0]).toBeInstanceOf(THREE.MeshSSSNodeMaterial);
  });

  it("decal groups render opaque with a polygon offset; shell groups don't", () => {
    const groups: GroupInfo[] = [
      { dyeIndex: 0, decal: false },
      { dyeIndex: 5, decal: true },
    ];
    const [shell, decal] = createGearMaterials(groups, noDyes, {}, {}) as THREE.MeshSSSNodeMaterial[];
    expect(decal.blending).toBe(THREE.NormalBlending);
    expect(decal.transparent).toBe(false);
    expect(decal.depthWrite).toBe(true);
    expect(decal.polygonOffset).toBe(true);
    expect(decal.polygonOffsetFactor).toBeLessThan(0);
    expect(shell.polygonOffset).toBe(false);
  });

  it("glow groups become alpha-tested self-lit materials", () => {
    const groups: GroupInfo[] = [{ dyeIndex: 0, decal: false, glow: true }];
    const mats = createGearMaterials(groups, noDyes, { diffuse: tex() }, {});
    const m = mats[0] as THREE.MeshStandardNodeMaterial;
    expect(m.transparent).toBe(true);
    expect(m.alphaTest).toBe(1);
  });
});

describe("createGearMaterials — full gearstack node graph", () => {
  function fullMaps() {
    return { diffuse: tex(), normal: tex(), gearstack: tex() };
  }

  it("wires colour/roughness/metalness/AO/emissive nodes when gearstack+diffuse exist", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true, plated: true },
    );
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    expect(m.roughnessNode).not.toBeNull();
    expect(m.metalnessNode).not.toBeNull();
    expect(m.aoNode).not.toBeNull();
    expect(m.emissiveNode).not.toBeNull();
    expect(m.normalNode).not.toBeNull();
    expect(m.outputNode).not.toBeNull(); // debug-channel override
  });

  it("exposes live uniforms for the debug channel and remap mode", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true },
    );
    const u = (
      mats[0].userData as {
        uniforms: {
          uDebugChannel: { value: number };
          uRoughnessRemapMode: { value: number };
          uWearRemapMode: { value: number };
        };
      }
    ).uniforms;
    expect(u.uDebugChannel.value).toBe(0);
    expect(u.uRoughnessRemapMode.value).toBe(DEFAULT_ROUGHNESS_REMAP_MODE);
    expect(u.uWearRemapMode.value).toBe(DEFAULT_WEAR_REMAP_MODE);
  });

  it("skips the node graph entirely for untextured materials (plain fallback)", () => {
    const mats = createGearMaterials([{ dyeIndex: 0, decal: false }], twoSlotDyes(), {}, {});
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).toBeNull();
    expect((m.userData as { uniforms?: unknown }).uniforms).toBeUndefined();
  });

  it("retains source textures and dye assignments when reconstructed boundaries are present", () => {
    const maps = fullMaps();
    const materialBoundaries = new THREE.DataTexture(new Uint8Array([255,80,32,200]), 1, 1);
    materialBoundaries.userData.materialBoundaries = { estimatedTexels: 1 };
    const material = createGearMaterials([{ dyeIndex: 3, decal: false }], twoSlotDyes(),
      { ...maps, materialBoundaries }, { useGearstack: true, applyDye: true })[0];
    expect(material.userData.destiny.slotSource).toBe("stage-part");
    expect(material.userData.destiny.boundaryReconstruction).toEqual({ estimatedTexels: 1 });
    expect(materialBoundaries.colorSpace).toBe(THREE.NoColorSpace);
    expect(maps.gearstack).not.toBe(materialBoundaries);
  });

  it("static metalness fallback comes from the decoded tint (gold slot 0 -> 1, secondary black paint -> 0)", () => {
    // dyeIndex 0 (even) is PRIMARY, dyeIndex 1 (odd) is SECONDARY — see
    // decodeChangeColorIndex.
    const primary = createGearMaterials([{ dyeIndex: 0, decal: false }], twoSlotDyes(), {}, {})[0] as THREE.MeshSSSNodeMaterial;
    const secondary = createGearMaterials([{ dyeIndex: 1, decal: false }], twoSlotDyes(), {}, {})[0] as THREE.MeshSSSNodeMaterial;
    expect(primary.metalness).toBe(1);
    expect(secondary.metalness).toBe(0);
  });

  it("cloth/fuzz slots get a sheen lobe; all-hard-surface sets don't", () => {
    const clothMat = createGearMaterials(
      [{ dyeIndex: 2, decal: false }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(clothMat.sheenNode).not.toBeNull();

    const hardOnly = dyeSetFromGearDyes({
      "0": { cloth: false, primary: { albedo: [1, 1, 1], metalness: 1 }, secondary: { albedo: [1, 1, 1], metalness: 1 } },
    });
    const hardMat = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      hardOnly,
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(hardMat.sheenNode).toBeNull();
  });

  it("SSS stays off (thicknessColorNode null) when the dye ships no strength", () => {
    const m = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(m.thicknessColorNode).toBeNull();
  });

  it("enables the SSS lighting path when the dye carries a subsurface strength", () => {
    const sssDyes = dyeSetFromGearDyes({
      "0": { cloth: false, primary: { albedo: [1, 1, 1], sss: 32 }, secondary: { albedo: [1, 1, 1] } },
    });
    // dyeIndex 0 is slot 0 PRIMARY (even) — see decodeChangeColorIndex.
    const m = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      sssDyes,
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(m.thicknessColorNode).not.toBeNull();
    expect(m.useSSS).toBe(true);
  });

  it("builds cleanly (colorNode/emissiveNode still wired) with a real dyeslot plate present", () => {
    // The map overrides both slot and parity in the default authored mode.
    const m = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { ...fullMaps(), dyeslot: tex() },
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    expect(m.emissiveNode).not.toBeNull();
    expect(m.userData.destiny.slotSource).toBe("dye-map");
  });

  it("builds cleanly regardless of materialTypeId (the emissive gate multiplies a factor, never skips node construction)", () => {
    // Relativism's unrecognized materialTypeId (0/3/4) suppresses the
    // B-channel emissive contribution — see KNOWN_EMISSIVE_MATERIAL_TYPE_IDS
    // — but must not break the node graph for items using it.
    const unusualMaterialDyes = dyeSetFromGearDyes({
      "0": {
        cloth: false,
        primary: { albedo: [1, 1, 1], materialTypeId: 4 },
        secondary: { albedo: [1, 1, 1], materialTypeId: 0 },
      },
    });
    const m = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      unusualMaterialDyes,
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(m.emissiveNode).not.toBeNull();
  });

  it("builds cleanly with repeated emissive tints (Relativism export shape)", () => {
    // Equality does not establish that exported emission is a placeholder.
    const repeatedEmissiveDyes = dyeSetFromGearDyes({
      "0": {
        primary: { materialTypeId: -1, emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { materialTypeId: -1, emissive: [1, 1, 1], emissiveIntensity: 1 },
      },
      "1": {
        cloth: true,
        primary: { materialTypeId: -1, emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { materialTypeId: -1, emissive: [1, 1, 1], emissiveIntensity: 1 },
      },
      "2": {
        primary: { materialTypeId: -1, emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { materialTypeId: -1, emissive: [1, 1, 1], emissiveIntensity: 1 },
      },
    });
    const m = createGearMaterials(
      [{ dyeIndex: 2, decal: false }],
      repeatedEmissiveDyes,
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(m.emissiveNode).not.toBeNull();
    expect(m.colorNode).not.toBeNull();
  });

  it("an unrecognized materialTypeId alone no longer triggers the pattern shimmer", () => {
    // Behavior change: the iridescence blend used to be gated by materialTypeId
    // (item/tint-wide, an inferred guess) — it's now gated by the real
    // per-stage-part pattern-texture signal (see isPatternGroup). A group with
    // an unrecognized materialTypeId but no patternTextures must build with no
    // uPatternTime uniform at all (the concrete, testable proxy for "the
    // pattern block didn't run") — colorNode still constructs either way.
    const unusualMaterialDyes = dyeSetFromGearDyes({
      "0": {
        cloth: false,
        primary: { albedo: [1, 1, 1], materialTypeId: 4 },
        secondary: { albedo: [1, 1, 1], materialTypeId: 0 },
      },
    });
    const m = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      unusualMaterialDyes,
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    const u = (m.userData as { uniforms: { uPatternTime?: unknown } }).uniforms;
    expect(u.uPatternTime).toBeUndefined();
  });
});

describe("pattern shimmer (isPatternGroup) — real per-stage-part signal, not materialTypeId", () => {
  function fullMaps() {
    return { diffuse: tex(), normal: tex(), gearstack: tex() };
  }
  const noiseTex = () => tex();
  const rippleTex = () => tex();
  const NOISE_NAME = "3107841013_vfx_warpmap_noise_a";
  const RIPPLE_NAME = "3107841013_vfx_warpmap_ripple_a";
  const TWIRL_NAME = "3107841013_vfx_warpmap_twirl_a";

  it("matchPatternTextureNames matches by suffix regardless of the numeric prefix", () => {
    expect(matchPatternTextureNames([NOISE_NAME, RIPPLE_NAME])).toEqual({
      noise: NOISE_NAME,
      ripple: RIPPLE_NAME,
    });
    expect(matchPatternTextureNames(["999_vfx_warpmap_noise_a"]).noise).toBe(
      "999_vfx_warpmap_noise_a",
    );
  });

  it("matchPatternTextureNames returns {} when neither suffix is present", () => {
    expect(matchPatternTextureNames([TWIRL_NAME, "2503085780_blob01_dif"])).toEqual({});
    expect(matchPatternTextureNames(undefined)).toEqual({});
    expect(matchPatternTextureNames([])).toEqual({});
  });

  it("matchPatternTextureNames requires both names independently (only one present ⇒ that half undefined)", () => {
    expect(matchPatternTextureNames([NOISE_NAME]).ripple).toBeUndefined();
    expect(matchPatternTextureNames([RIPPLE_NAME]).noise).toBeUndefined();
  });

  it("isPatternGroup is true only when a group carries BOTH names", () => {
    expect(isPatternGroup({ dyeIndex: 0, decal: false, patternTextures: [NOISE_NAME, RIPPLE_NAME] })).toBe(
      true,
    );
    expect(isPatternGroup({ dyeIndex: 0, decal: false, patternTextures: [NOISE_NAME] })).toBe(false);
    expect(isPatternGroup({ dyeIndex: 0, decal: false })).toBe(false);
    // The unconfirmed twirl/blob/darkness accent set — intentionally out of
    // scope, must not trigger the shimmer path.
    expect(
      isPatternGroup({
        dyeIndex: 0,
        decal: false,
        patternTextures: [TWIRL_NAME, "2503085780_blob01_dif", "1442532712_darkness_plate"],
      }),
    ).toBe(false);
  });

  it("a pattern group with both textures resolved exposes uPatternTime, starting at 0", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, patternTextures: [NOISE_NAME, RIPPLE_NAME] }],
      twoSlotDyes(),
      { ...fullMaps(), patternNoise: noiseTex(), patternRipple: rippleTex() },
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    const u = (m.userData as { uniforms: { uPatternTime?: { value: number } } }).uniforms;
    expect(u.uPatternTime?.value).toBe(0);
  });

  it("an ordinary group (no patternTextures) never exposes uPatternTime, even with maps present", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { ...fullMaps(), patternNoise: noiseTex(), patternRipple: rippleTex() },
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    const u = (m.userData as { uniforms: { uPatternTime?: unknown } }).uniforms;
    expect(u.uPatternTime).toBeUndefined();
  });

  it("a pattern group with matching names but no resolved textures falls through with no crash and no uPatternTime", () => {
    // loadGearModel.ts only populates maps.patternNoise/Ripple when the named
    // entries actually resolve — this covers a stage part claiming the names
    // but the loader failing (or being given) neither texture.
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, patternTextures: [NOISE_NAME, RIPPLE_NAME] }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    const u = (m.userData as { uniforms: { uPatternTime?: unknown } }).uniforms;
    expect(u.uPatternTime).toBeUndefined();
  });

  it("advancePatternTime accumulates seconds on pattern materials, and is a no-op otherwise", () => {
    const patterned = createGearMaterials(
      [{ dyeIndex: 0, decal: false, patternTextures: [NOISE_NAME, RIPPLE_NAME] }],
      twoSlotDyes(),
      { ...fullMaps(), patternNoise: noiseTex(), patternRipple: rippleTex() },
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const ordinary = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), [patterned, ordinary]));

    const u = (patterned.userData as { uniforms: { uPatternTime: { value: number } } }).uniforms;
    expect(u.uPatternTime.value).toBe(0);

    advancePatternTime(root, 0.5);
    expect(u.uPatternTime.value).toBeCloseTo(0.5);
    advancePatternTime(root, 0.25);
    expect(u.uPatternTime.value).toBeCloseTo(0.75);

    expect(
      (ordinary.userData as { uniforms: { uPatternTime?: unknown } }).uniforms.uPatternTime,
    ).toBeUndefined();
  });
});

describe("swirling-darkness accent (isAccentGroup) — the type-8 twirl/blob/darkness trio", () => {
  function fullMaps() {
    return { diffuse: tex(), normal: tex(), gearstack: tex() };
  }
  const TWIRL = "3107841013_vfx_warpmap_twirl_a";
  const BLOB = "2503085780_blob01_dif";
  const DARKNESS = "1442532712_darkness_plate";
  const NOISE = "3107841013_vfx_warpmap_noise_a";
  const RIPPLE = "3107841013_vfx_warpmap_ripple_a";

  it("matchAccentTextureNames finds all three by suffix regardless of numeric prefix", () => {
    expect(matchAccentTextureNames([TWIRL, BLOB, DARKNESS])).toEqual({
      twirl: TWIRL,
      blob: BLOB,
      darkness: DARKNESS,
    });
    expect(matchAccentTextureNames(["9_vfx_warpmap_twirl_a", "9_blob01_dif", "9_darkness_plate"]))
      .toEqual({ twirl: "9_vfx_warpmap_twirl_a", blob: "9_blob01_dif", darkness: "9_darkness_plate" });
  });

  it("isAccentGroup requires all three; the shimmer pair does NOT trigger it", () => {
    expect(isAccentGroup({ dyeIndex: 0, decal: false, patternTextures: [TWIRL, BLOB, DARKNESS] })).toBe(true);
    expect(isAccentGroup({ dyeIndex: 0, decal: false, patternTextures: [TWIRL, BLOB] })).toBe(false);
    expect(isAccentGroup({ dyeIndex: 0, decal: false, patternTextures: [NOISE, RIPPLE] })).toBe(false);
    expect(isAccentGroup({ dyeIndex: 0, decal: false })).toBe(false);
  });

  it("accent and pattern are mutually exclusive (disjoint texture sets)", () => {
    const accentGroup = { dyeIndex: 0, decal: false, patternTextures: [TWIRL, BLOB, DARKNESS] };
    expect(isAccentGroup(accentGroup)).toBe(true);
    expect(isPatternGroup(accentGroup)).toBe(false);
  });

  it("an accent group with all three textures resolved exposes uPatternTime, starting at 0", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, patternTextures: [TWIRL, BLOB, DARKNESS] }],
      twoSlotDyes(),
      { ...fullMaps(), accentTwirl: tex(), accentBlob: tex(), accentDarkness: tex() },
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    const u = (m.userData as { uniforms: { uPatternTime?: { value: number } } }).uniforms;
    expect(u.uPatternTime?.value).toBe(0);
  });

  it("advancePatternTime drives the accent clock too (shared with the shimmer)", () => {
    const accent = createGearMaterials(
      [{ dyeIndex: 0, decal: false, patternTextures: [TWIRL, BLOB, DARKNESS] }],
      twoSlotDyes(),
      { ...fullMaps(), accentTwirl: tex(), accentBlob: tex(), accentDarkness: tex() },
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), accent));
    const u = (accent.userData as { uniforms: { uPatternTime: { value: number } } }).uniforms;
    expect(u.uPatternTime.value).toBe(0);
    advancePatternTime(root, 0.5);
    expect(u.uPatternTime.value).toBeCloseTo(0.5);
  });

  it("an accent group whose textures didn't resolve falls through with no crash and no uPatternTime", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, patternTextures: [TWIRL, BLOB, DARKNESS] }],
      twoSlotDyes(),
      fullMaps(),
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).not.toBeNull();
    const u = (m.userData as { uniforms: { uPatternTime?: unknown } }).uniforms;
    expect(u.uPatternTime).toBeUndefined();
  });
});

describe("needsBandSplit — per-pixel A-channel split gate", () => {
  it("fires for a single-part mesh (Cover of the Exile: one part, dye index 3)", () => {
    expect(needsBandSplit([{ dyeIndex: 3, decal: false }])).toBe(true);
  });

  it("fires when several parts all decode to the SAME slot (indices 2 and 3 are both slot 1)", () => {
    expect(
      needsBandSplit([
        { dyeIndex: 2, decal: false },
        { dyeIndex: 3, decal: false },
      ]),
    ).toBe(true);
  });

  it("does NOT fire when parts carry real per-slot variation (Nighthawk: slots 0/1/2)", () => {
    expect(
      needsBandSplit([
        { dyeIndex: 0, decal: false },
        { dyeIndex: 2, decal: false },
        { dyeIndex: 5, decal: true },
      ]),
    ).toBe(false);
  });

  it("ignores glow groups when counting slots", () => {
    expect(
      needsBandSplit([
        { dyeIndex: 3, decal: false },
        { dyeIndex: 0, decal: false, glow: true },
      ]),
    ).toBe(true);
  });

  it("no longer bails just because a dyeslot plate exists — eligibility is now dyeslot-independent", () => {
    // Behavior change (Relativism 2809120022): dyeslot presence used to force
    // this false unconditionally. Now the caller (createGearMaterials'
    // bandSplit) decides whether the result is used as the PRIMARY slot
    // source or as makeOpaque's FALLBACK for texels a real-but-sparse plate
    // leaves unassigned — needsBandSplit itself only answers "do these parts
    // share one slot," independent of dyeslot data.
    expect(needsBandSplit([{ dyeIndex: 3, decal: false }])).toBe(true);
  });
});

describe("createGearMaterials — band-split fallback behind a real dyeslot plate", () => {
  it("builds cleanly with singlePart:false + a dyeslot map + single-slot groups (Relativism's shape)", () => {
    // Relativism (2809120022) has 2 real geometry files (shell + cloth), so
    // singlePart is correctly false — but band-split is still needed as
    // makeOpaque's fallback for texels its dyeslot plate leaves unassigned
    // (see the bandSplit computation in createGearMaterials). This only
    // confirms the node graph still constructs under that combination; the
    // actual per-pixel recovery is checked live against /poc.
    const groups: GroupInfo[] = [
      { dyeIndex: 0, decal: false },
      { dyeIndex: 0, decal: true },
    ];
    const mats = createGearMaterials(
      groups,
      twoSlotDyes(),
      { diffuse: tex(), normal: tex(), gearstack: tex(), dyeslot: tex() },
      { useGearstack: true, applyDye: true, singlePart: false },
    );
    expect(mats).toHaveLength(2);
    for (const m of mats) {
      expect((m as THREE.MeshSSSNodeMaterial).colorNode).not.toBeNull();
    }
  });
});

describe("live uniform setters", () => {
  function materialInScene() {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    );
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mats[0]);
    const root = new THREE.Group();
    root.add(mesh);
    const u = (
      mats[0].userData as {
        uniforms: {
          uDebugChannel: { value: number };
          uRoughnessRemapMode: { value: number };
          uWearRemapMode: { value: number };
        };
      }
    ).uniforms;
    return { root, u };
  }

  it("setGearstackDebugChannel updates every gear material under a group", () => {
    const { root, u } = materialInScene();
    setGearstackDebugChannel(root, 3);
    expect(u.uDebugChannel.value).toBe(3);
    setGearstackDebugChannel(root, 0);
    expect(u.uDebugChannel.value).toBe(0);
  });

  it("setRoughnessRemapMode switches the roughness remap interpretation live", () => {
    const { root, u } = materialInScene();
    setRoughnessRemapMode(root, 1);
    expect(u.uRoughnessRemapMode.value).toBe(1);
  });

  it("setWearRemapMode switches the wear remap interpretation live, independently of roughness", () => {
    const { root, u } = materialInScene();
    setWearRemapMode(root, 2);
    expect(u.uWearRemapMode.value).toBe(2);
    expect(u.uRoughnessRemapMode.value).toBe(DEFAULT_ROUGHNESS_REMAP_MODE);
  });

  it("setBandThresholds updates band cuts live and partially", () => {
    const { root, u } = materialInScene() as unknown as {
      root: THREE.Group;
      u: { uBandT1: { value: number }; uBandT2: { value: number } };
    };
    expect(u.uBandT1.value).toBe(BAND_DEFAULTS.t1);
    expect(u.uBandT2.value).toBe(BAND_DEFAULTS.t2);
    setBandThresholds(root, { t1: 0.42 });
    expect(u.uBandT1.value).toBe(0.42);
    expect(u.uBandT2.value).toBe(BAND_DEFAULTS.t2);
  });

  it("setBandMode switches the (slot, parity) band decode live", () => {
    const { root, u } = materialInScene() as unknown as {
      root: THREE.Group;
      u: { uBandMode: { value: number } };
    };
    expect(BAND_MODES).toHaveLength(4);
    expect(u.uBandMode.value).toBe(DEFAULT_BAND_MODE);
    setBandMode(root, 1);
    expect(u.uBandMode.value).toBe(1);
  });

  it("exposes raw channels, resolved materials, decoded alpha, and estimated boundaries", () => {
    expect(GEARSTACK_CHANNELS).toHaveLength(10);
    expect(GEARSTACK_CHANNELS[0]).toBe("off");
  });

  it("offers authored remapping alongside three legacy comparisons", () => {
    expect(REMAP_MODES).toHaveLength(4);
    expect(DEFAULT_ROUGHNESS_REMAP_MODE).toBe(3);
    expect(DEFAULT_WEAR_REMAP_MODE).toBe(3);
    expect(DEFAULT_BAND_MODE).toBe(3);
  });
});

describe("animated glow (GearMaterialOptions.animatedGlow)", () => {
  it("does NOT expose uGlowEnabled for ordinary items (opt-in only)", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    );
    const u = (mats[0].userData as { uniforms: { uGlowEnabled?: { value: number } } }).uniforms;
    expect(u.uGlowEnabled).toBeUndefined();
  });

  it("exposes uGlowEnabled with the configured default when animatedGlow is set", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true },
    );
    const u = (mats[0].userData as { uniforms: { uGlowEnabled?: { value: number } } }).uniforms;
    expect(u.uGlowEnabled?.value).toBe(DEFAULT_GLOW_ENABLED ? 1 : 0);
  });

  it("setGlowEnabled toggles the uniform live, and is a no-op on materials without it", () => {
    const animated = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const ordinary = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), [animated, ordinary]));

    const u = (animated.userData as { uniforms: { uGlowEnabled: { value: number } } }).uniforms;
    expect(u.uGlowEnabled.value).toBe(DEFAULT_GLOW_ENABLED ? 1 : 0);

    setGlowEnabled(root, true);
    expect(u.uGlowEnabled.value).toBe(1);
    expect(
      (ordinary.userData as { uniforms: { uGlowEnabled?: unknown } }).uniforms.uGlowEnabled,
    ).toBeUndefined();

    setGlowEnabled(root, false);
    expect(u.uGlowEnabled.value).toBe(0);
  });

  it("advanceGlowTime accumulates seconds on animated materials, and is a no-op otherwise", () => {
    const animated = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const ordinary = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    )[0] as THREE.MeshSSSNodeMaterial;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), [animated, ordinary]));

    const u = (animated.userData as { uniforms: { uGlowTime: { value: number } } }).uniforms;
    expect(u.uGlowTime.value).toBe(0);

    advanceGlowTime(root, 0.5);
    expect(u.uGlowTime.value).toBeCloseTo(0.5);
    advanceGlowTime(root, 0.25);
    expect(u.uGlowTime.value).toBeCloseTo(0.75);

    expect(
      (ordinary.userData as { uniforms: { uGlowTime?: unknown } }).uniforms.uGlowTime,
    ).toBeUndefined();
  });
});

describe("ability-VFX geometry (flags & 0x2000, gated by animatedGlow — NOT universal)", () => {
  it("renders a flagged group as ordinary opaque geometry when animatedGlow is off", () => {
    // This bit is NOT a reliable universal signal — see isAbilityVfxGroup's
    // doc comment (confirmed wrong on Relativism, where the same bit sits on
    // an ordinary always-visible decal part, its hood). So without an
    // animatedGlow opt-in, a flagged group falls through to the normal
    // opaque path exactly like any other group.
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, flags: 0x2000 }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    );
    expect(mats[0]).toBeInstanceOf(THREE.MeshSSSNodeMaterial);
    expect(mats[0].transparent).toBe(false);
  });

  it("renders a flagged group as transparent, invisible-by-default VFX geometry when animatedGlow is on", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, flags: 0x2000 }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true },
    );
    const m = mats[0] as THREE.MeshStandardNodeMaterial;
    expect(m).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.opacityNode).not.toBeNull();
    expect(m.emissiveNode).not.toBeNull();
    const u = (m.userData as { uniforms: { uGlowEnabled: { value: number } } }).uniforms;
    expect(u.uGlowEnabled.value).toBe(DEFAULT_GLOW_ENABLED ? 1 : 0);
  });

  it("does NOT flag an unflagged group as VFX geometry even with animatedGlow on", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false, flags: 0 }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true },
    );
    expect(mats[0]).toBeInstanceOf(THREE.MeshSSSNodeMaterial);
    expect(mats[0].transparent).toBe(false);
  });

  it("setGlowEnabled/advanceGlowTime/hasAnimatedGlow drive VFX-geometry materials (shared uniform shape)", () => {
    const vfx = createGearMaterials(
      [{ dyeIndex: 0, decal: false, flags: 0x2000 }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true },
    )[0];
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), vfx));

    expect(hasAnimatedGlow(root)).toBe(true);
    setGlowEnabled(root, true);
    const u = (vfx.userData as { uniforms: { uGlowEnabled: { value: number }; uGlowTime: { value: number } } })
      .uniforms;
    expect(u.uGlowEnabled.value).toBe(1);
    advanceGlowTime(root, 1.2);
    expect(u.uGlowTime.value).toBeCloseTo(1.2);
  });

  it("hasAnimatedGlow is false when nothing on the model has a glow-capable material", () => {
    const ordinary = createGearMaterials(
      [{ dyeIndex: 0, decal: false, flags: 0x2000 }],
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    )[0];
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), ordinary));
    expect(hasAnimatedGlow(root)).toBe(false);
  });

  it("computes a vfxRadial gradient from sourceGeometry: 0 near the base, 1 at the farthest tip", () => {
    // 3 shell vertices at the centre (not part of any VFX group), then 3 VFX
    // vertices at increasing distance from the bounding-sphere centre.
    const positions = new Float32Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0,
      1, 0, 0, 2, 0, 0, 3, 0, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex([0, 1, 2, 3, 4, 5]);
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);

    const groups: GroupInfo[] = [
      { dyeIndex: 0, decal: false, flags: 0 },
      { dyeIndex: 0, decal: false, flags: 0x2000 },
    ];

    createGearMaterials(
      groups,
      twoSlotDyes(),
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true, animatedGlow: true, sourceGeometry: geometry },
    );

    const attr = geometry.getAttribute("vfxRadial") as THREE.BufferAttribute;
    expect(attr).toBeDefined();
    expect(attr.getX(3)).toBeCloseTo(0); // base
    expect(attr.getX(4)).toBeCloseTo(0.5);
    expect(attr.getX(5)).toBeCloseTo(1); // tip
    expect(attr.getX(0)).toBe(0); // untouched shell vertex, safe default
  });
});

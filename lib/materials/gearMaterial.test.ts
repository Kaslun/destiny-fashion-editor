import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import {
  createGearMaterials,
  decodeChangeColorIndex,
  needsBandSplit,
  setGearstackDebugChannel,
  setRemapMode,
  setBandThresholds,
  setBandMode,
  BAND_DEFAULTS,
  BAND_MODES,
  DEFAULT_BAND_MODE,
  GEARSTACK_CHANNELS,
  REMAP_MODES,
  DEFAULT_REMAP_MODE,
} from "./gearMaterial";
import { dyeSetFromGearDyes } from "./gearDye";
import type { DyeSet } from "./gearDye";
import type { GroupInfo } from "@/lib/geometry/buildGeometry";

const noDyes: DyeSet = {};
const tex = () => new THREE.Texture();

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

  it("negative/garbage indices clamp safely", () => {
    expect(decodeChangeColorIndex(-1).slot).toBe(0);
    expect(decodeChangeColorIndex(99).slot).toBe(3);
  });
});

describe("createGearMaterials — material class & decal handling", () => {
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
    const u = (mats[0].userData as { uniforms: { uDebugChannel: { value: number }; uRemapMode: { value: number } } }).uniforms;
    expect(u.uDebugChannel.value).toBe(0);
    expect(u.uRemapMode.value).toBe(DEFAULT_REMAP_MODE);
  });

  it("skips the node graph entirely for untextured materials (plain fallback)", () => {
    const mats = createGearMaterials([{ dyeIndex: 0, decal: false }], twoSlotDyes(), {}, {});
    const m = mats[0] as THREE.MeshSSSNodeMaterial;
    expect(m.colorNode).toBeNull();
    expect((m.userData as { uniforms?: unknown }).uniforms).toBeUndefined();
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
});

describe("needsBandSplit — per-pixel A-channel split gate", () => {
  it("fires for a single-part mesh (Cover of the Exile: one part, dye index 3)", () => {
    expect(needsBandSplit([{ dyeIndex: 3, decal: false }], false)).toBe(true);
  });

  it("fires when several parts all decode to the SAME slot (indices 2 and 3 are both slot 1)", () => {
    expect(
      needsBandSplit(
        [
          { dyeIndex: 2, decal: false },
          { dyeIndex: 3, decal: false },
        ],
        false,
      ),
    ).toBe(true);
  });

  it("does NOT fire when parts carry real per-slot variation (Nighthawk: slots 0/1/2)", () => {
    expect(
      needsBandSplit(
        [
          { dyeIndex: 0, decal: false },
          { dyeIndex: 2, decal: false },
          { dyeIndex: 5, decal: true },
        ],
        false,
      ),
    ).toBe(false);
  });

  it("does NOT fire when a per-pixel dyeslot plate exists (real data wins)", () => {
    expect(needsBandSplit([{ dyeIndex: 3, decal: false }], true)).toBe(false);
  });

  it("ignores glow groups when counting slots", () => {
    expect(
      needsBandSplit(
        [
          { dyeIndex: 3, decal: false },
          { dyeIndex: 0, decal: false, glow: true },
        ],
        false,
      ),
    ).toBe(true);
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
    const u = (mats[0].userData as { uniforms: { uDebugChannel: { value: number }; uRemapMode: { value: number } } }).uniforms;
    return { root, u };
  }

  it("setGearstackDebugChannel updates every gear material under a group", () => {
    const { root, u } = materialInScene();
    setGearstackDebugChannel(root, 3);
    expect(u.uDebugChannel.value).toBe(3);
    setGearstackDebugChannel(root, 0);
    expect(u.uDebugChannel.value).toBe(0);
  });

  it("setRemapMode switches the remap interpretation live", () => {
    const { root, u } = materialInScene();
    setRemapMode(root, 2);
    expect(u.uRemapMode.value).toBe(2);
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
    expect(BAND_MODES).toHaveLength(3);
    expect(u.uBandMode.value).toBe(DEFAULT_BAND_MODE);
    setBandMode(root, 1);
    expect(u.uBandMode.value).toBe(1);
  });

  it("exposes exactly 7 channel labels (off + r/g/b/a + resolved slot + a-bands)", () => {
    expect(GEARSTACK_CHANNELS).toHaveLength(7);
    expect(GEARSTACK_CHANNELS[0]).toBe("off");
  });

  it("exposes 3 remap interpretations", () => {
    expect(REMAP_MODES).toHaveLength(3);
  });
});

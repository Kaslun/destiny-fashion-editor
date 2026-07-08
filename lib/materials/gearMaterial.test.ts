import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createGearMaterials, setGearstackDebugChannel, GEARSTACK_CHANNELS } from "./gearMaterial";
import type { DyeSet } from "./gearDye";
import type { GroupInfo } from "@/lib/geometry/buildGeometry";

const noDyes: DyeSet = {};

describe("createGearMaterials — decal/overlay handling", () => {
  it("renders decal groups as opaque overlays (polygon offset), not additive", () => {
    const groups: GroupInfo[] = [
      { dyeIndex: 0, decal: false },
      { dyeIndex: 5, decal: true },
    ];
    const mats = createGearMaterials(groups, noDyes, {}, {});
    expect(mats).toHaveLength(2);

    const [shell, decal] = mats as THREE.MeshStandardMaterial[];
    expect(shell).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(decal).toBeInstanceOf(THREE.MeshStandardMaterial);

    // Decals are baked-art panels: opaque, normal-blended, depth-writing.
    expect(decal.blending).toBe(THREE.NormalBlending);
    expect(decal.transparent).toBe(false);
    expect(decal.depthWrite).toBe(true);

    // ...but polygon-offset so they sit on the shell without z-fighting.
    expect(decal.polygonOffset).toBe(true);
    expect(decal.polygonOffsetFactor).toBeLessThan(0);
    expect(shell.polygonOffset).toBe(false);
  });

  it("opaque shell groups are lit standard materials, not additive", () => {
    const mats = createGearMaterials([{ dyeIndex: 0, decal: false }], noDyes, {}, {});
    const m = mats[0] as THREE.MeshStandardMaterial;
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.blending).toBe(THREE.NormalBlending);
    expect(m.transparent).toBe(false);
  });
});

describe("createGearMaterials — detail-strength weighting (Nighthawk weave fix)", () => {
  const tex = () => new THREE.Texture();
  function dyeWithStrength(strength: number) {
    return {
      0: {
        primary: new THREE.Color(0xffffff),
        secondary: new THREE.Color(0xffffff),
        roughness: 0.6, metalness: 0,
        emissive: new THREE.Color(0, 0, 0),
        secondaryEmissive: new THREE.Color(0, 0, 0),
        detailDiffuseName: "kevlar_dif", detailNormalName: null,
        detailTransform: [7.5, 7.5, 0, 0] as [number, number, number, number],
        cloth: false,
        detailStrength: strength,
        detailDiffuse: tex(),
      },
    };
  }

  function fragmentFor(strength: number): string {
    const maps = { diffuse: tex(), gearstack: tex() };
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      dyeWithStrength(strength) as any,
      maps as any,
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshStandardMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>` };
    (m.onBeforeCompile as any)?.(shader);
    return JSON.stringify({ src: shader.fragmentShader, strength: shader.uniforms.uDetailStrength?.value });
  }

  it("detail-diffuse branch is present and gated by uDetailStrength at runtime", () => {
    const out = fragmentFor(1);
    expect(out).toContain("uDetailStrength > 0.001");
    expect(out).toContain("diffuseColor.rgb *= mod");
  });

  it("zero-strength slot (gold plate) passes detailStrength=0, suppressing the weave at runtime", () => {
    // The branch compiles in, but the uniform is 0 so it's a no-op in-shader.
    const out = JSON.parse(fragmentFor(0));
    expect(out.strength).toBe(0);
  });

  it("cloth slot passes full detailStrength=1", () => {
    const out = JSON.parse(fragmentFor(1));
    expect(out.strength).toBe(1);
  });
});

describe("createGearMaterials — plated metalness gated per-slot by cloth", () => {
  const tex = () => new THREE.Texture();
  function slot(cloth: boolean) {
    return {
      0: {
        primary: new THREE.Color(0xffd700), secondary: new THREE.Color(0xffffff),
        roughness: cloth ? 0.85 : 0.6, metalness: 0,
        emissive: new THREE.Color(0, 0, 0), secondaryEmissive: new THREE.Color(0, 0, 0),
        detailDiffuseName: null, detailNormalName: null,
        detailTransform: [1, 1, 0, 0] as [number, number, number, number],
        cloth, detailStrength: cloth ? 1 : 0,
      },
    };
  }
  function frag(cloth: boolean): { src: string; uSlotCloth: number } {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }], slot(cloth) as any,
      { diffuse: tex(), gearstack: tex() } as any,
      { useGearstack: true, applyDye: true, plated: true },
    );
    const m = mats[0] as THREE.MeshStandardMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>` };
    (m.onBeforeCompile as any)?.(shader);
    return { src: shader.fragmentShader, uSlotCloth: shader.uniforms.uSlotCloth?.value };
  }

  it("metalness comes from the decoded gearstack alpha channel on non-dyed pixels only", () => {
    const src = frag(false).src;
    expect(src).toContain("decodeGearstack");
    expect(src).toContain("if ( gsM.dyeMask < 0.5 ) {");
    expect(src).toContain("metalnessFactor = gsM.metalness;");
  });

  it("cloth slots are forced dielectric in the metalness block", () => {
    expect(frag(false).src).toContain("if ( clothFloorM > 0.5 ) metalnessFactor = 0.0;");
  });

  it("non-cloth slot passes uSlotCloth=0 so gold gets the metal override", () => {
    expect(frag(false).uSlotCloth).toBe(0);
  });

  it("cloth slot passes uSlotCloth=1 so the override is skipped (fabric stays dielectric)", () => {
    expect(frag(true).uSlotCloth).toBe(1);
  });
});

describe("createGearMaterials — orphan-slot A-channel material split", () => {
  const tex = () => new THREE.Texture();
  // Mirrors Cover of the Exile (571925067): slot 0 metal, slot 1 cloth, no
  // per-pixel dyeslot plate.
  const clothMetalDyes: DyeSet = {
    0: {
      primary: new THREE.Color(0xffa032), secondary: new THREE.Color(0xffffff),
      roughness: 0.5, metalness: 1,
      emissive: new THREE.Color(0, 0, 0), secondaryEmissive: new THREE.Color(0, 0, 0),
      detailDiffuseName: null, detailNormalName: null,
      detailTransform: [1, 1, 0, 0], cloth: false, detailStrength: 0,
      roughnessRemap: [1, 0, 0, 1], hasRoughnessRemap: false,
      wearRemap: [1, 0, 0, 1], hasWearRemap: false, sssStrength: 0,
    } as any,
    1: {
      primary: new THREE.Color(0x0d4849), secondary: new THREE.Color(0xffffff),
      roughness: 0.85, metalness: 0,
      emissive: new THREE.Color(0, 0, 0), secondaryEmissive: new THREE.Color(0, 0, 0),
      detailDiffuseName: null, detailNormalName: null,
      detailTransform: [1, 1, 0, 0], cloth: true, detailStrength: 1,
      roughnessRemap: [1, 0, 0, 1], hasRoughnessRemap: false,
      wearRemap: [1, 0, 0, 1], hasWearRemap: false, sssStrength: 0,
    } as any,
  };

  function compile(groups: GroupInfo[], groupIndex: number) {
    const mats = createGearMaterials(groups, clothMetalDyes, { diffuse: tex(), gearstack: tex() }, {
      useGearstack: true,
      applyDye: true,
    });
    const m = mats[groupIndex] as THREE.MeshPhysicalMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>` };
    (m.onBeforeCompile as any)?.(shader);
    return shader;
  }

  it("fires when a single-group mesh's dyeIndex matches no slot (Cover of the Exile: single group, dyeIndex=3)", () => {
    const shader = compile([{ dyeIndex: 3, decal: false }], 0);
    expect(shader.uniforms.uUseAChannelSplit.value).toBe(1);
    expect(shader.fragmentShader).toContain("aChannelMaterialSlot");
  });

  it("does NOT fire on an orphan group when a sibling group in the same mesh already resolves (Nighthawk regression: dyeIndex 0/1 resolve, dyeIndex 5 crown decal doesn't)", () => {
    const groups: GroupInfo[] = [
      { dyeIndex: 0, decal: false },
      { dyeIndex: 1, decal: false },
      { dyeIndex: 5, decal: true },
    ];
    const orphanShader = compile(groups, 2);
    expect(orphanShader.uniforms.uUseAChannelSplit.value).toBe(0);
    // The resolving groups should never get the split either.
    expect(compile(groups, 0).uniforms.uUseAChannelSplit.value).toBe(0);
  });

  it("does not fire when the dye set has no cloth/metal split available", () => {
    const oneMaterialDyes: DyeSet = { 0: clothMetalDyes[0] };
    const mats = createGearMaterials([{ dyeIndex: 3, decal: false }], oneMaterialDyes, { diffuse: tex(), gearstack: tex() }, {
      useGearstack: true,
      applyDye: true,
    });
    const m = mats[0] as THREE.MeshPhysicalMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>` };
    (m.onBeforeCompile as any)?.(shader);
    expect(shader.uniforms.uUseAChannelSplit.value).toBe(0);
  });
});

describe("createGearMaterials — documented roughness/wear remap", () => {
  const tex = () => new THREE.Texture();
  function dyeWithRemap(hasRoughnessRemap: boolean, hasWearRemap: boolean) {
    return {
      0: {
        primary: new THREE.Color(0xffffff), secondary: new THREE.Color(0xffffff),
        roughness: 0.6, metalness: 0,
        emissive: new THREE.Color(0, 0, 0), secondaryEmissive: new THREE.Color(0, 0, 0),
        detailDiffuseName: null, detailNormalName: null,
        detailTransform: [1, 1, 0, 0] as [number, number, number, number],
        cloth: false, detailStrength: 0,
        roughnessRemap: [2, 0.1, 0.05, 0.9] as [number, number, number, number],
        hasRoughnessRemap,
        wearRemap: [1.5, 0, 0, 1] as [number, number, number, number],
        hasWearRemap,
        sssStrength: 0,
      },
    };
  }
  function frag(hasRoughnessRemap: boolean, hasWearRemap: boolean): string {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }], dyeWithRemap(hasRoughnessRemap, hasWearRemap) as any,
      { diffuse: tex(), gearstack: tex() } as any,
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshPhysicalMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>` };
    (m.onBeforeCompile as any)?.(shader);
    return shader.fragmentShader;
  }

  it("roughness remap branch is present, gated by uHasRoughnessRemap, and inverts the remapped smoothness to roughness", () => {
    const src = frag(true, false);
    expect(src).toContain("applyRemap4");
    expect(src).toContain("if ( hasRoughRemapR > 0.5 )");
    expect(src).toContain("float remappedSmoothness = applyRemap4( gsR.smoothness, roughRemapR, 1.0 );");
    expect(src).toContain("roughnessFactor = clamp( 1.0 - remappedSmoothness, 0.0, 1.0 );");
  });

  it("applyRemap4 is a range remap (in_min,in_max,out_min,out_max), not scale+bias+clamp", () => {
    const src = frag(true, false);
    expect(src).toContain("float t = clamp( ( raw - r.x ) / max( r.y - r.x, 1e-5 ), 0.0, 1.0 );");
    expect(src).toContain("return mix( r.z, r.w, t );");
  });

  it("wear remap is applied via applyRemap4 in both the dye-tint and roughness blocks", () => {
    const src = frag(false, true);
    expect(src).toContain("float wearAmt = applyRemap4( gs.wearRaw, wearRemapT, hasWearRemapT );");
    expect(src).toContain("float wearAmtR = applyRemap4( gsR.wearRaw, wearRemapR, hasWearRemapR );");
  });

  it("compiles the same branches regardless of has-flags (runtime gate, not a compile-time toggle)", () => {
    expect(frag(false, false)).toContain("if ( hasRoughRemapR > 0.5 )");
  });
});

describe("createGearMaterials — fuzz/sheen for cloth-flagged slots", () => {
  const tex = () => new THREE.Texture();
  function dyeCloth(cloth: boolean) {
    return {
      0: {
        primary: new THREE.Color(0xff0000), secondary: new THREE.Color(0xffffff),
        roughness: 0.8, metalness: 0,
        emissive: new THREE.Color(0, 0, 0), secondaryEmissive: new THREE.Color(0, 0, 0),
        detailDiffuseName: null, detailNormalName: null,
        detailTransform: [1, 1, 0, 0] as [number, number, number, number],
        cloth, detailStrength: cloth ? 1 : 0,
      },
    };
  }

  it("cloth-flagged group gets a non-zero sheen", () => {
    const mats = createGearMaterials([{ dyeIndex: 0, decal: false }], dyeCloth(true) as any, {}, {});
    const m = mats[0] as THREE.MeshPhysicalMaterial;
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(m.sheen).toBeGreaterThan(0);
  });

  it("non-cloth group gets zero sheen", () => {
    const mats = createGearMaterials([{ dyeIndex: 0, decal: false }], dyeCloth(false) as any, {}, {});
    const m = mats[0] as THREE.MeshPhysicalMaterial;
    expect(m.sheen).toBe(0);
  });
});

describe("gearstack debug-channel viewer", () => {
  const tex = () => new THREE.Texture();

  it("wires a live uDebugChannel uniform + dithering override when a gearstack map exists", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }], noDyes,
      { diffuse: tex(), gearstack: tex() },
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshStandardMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>
      #include <dithering_fragment>` };
    (m.onBeforeCompile as any)?.(shader);

    expect(shader.uniforms.uDebugChannel).toEqual({ value: 0 });
    expect(shader.fragmentShader).toContain("uniform float uDebugChannel;");
    expect(shader.fragmentShader).toContain("if ( uDebugChannel > 0.5 )");
    // m.userData.shader is what setGearstackDebugChannel mutates live.
    expect((m.userData as any).shader).toBe(shader);
  });

  it("has no debug-channel wiring when the item ships no gearstack map", () => {
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }], noDyes,
      { diffuse: tex() },
      { useGearstack: true, applyDye: true },
    );
    const m = mats[0] as THREE.MeshStandardMaterial;
    // No gearstack, no detail maps -> onBeforeCompile is never assigned at all.
    expect(m.onBeforeCompile).toBe(THREE.Material.prototype.onBeforeCompile);
  });

  it("setGearstackDebugChannel updates every gearstack-enabled material under a group", () => {
    const groups: GroupInfo[] = [{ dyeIndex: 0, decal: false }];
    const mats = createGearMaterials(groups, noDyes, { diffuse: tex(), gearstack: tex() }, {
      useGearstack: true,
      applyDye: true,
    });
    const m = mats[0] as THREE.MeshStandardMaterial;
    const shader: any = { uniforms: {}, fragmentShader: "#include <dithering_fragment>" };
    (m.onBeforeCompile as any)?.(shader);

    const geom = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geom, m);
    const root = new THREE.Group();
    root.add(mesh);

    setGearstackDebugChannel(root, 3);
    expect(shader.uniforms.uDebugChannel.value).toBe(3);

    setGearstackDebugChannel(root, 0);
    expect(shader.uniforms.uDebugChannel.value).toBe(0);
  });

  it("exposes exactly 5 channel labels (off + r/g/b/a)", () => {
    expect(GEARSTACK_CHANNELS).toHaveLength(5);
    expect(GEARSTACK_CHANNELS[0]).toBe("off");
  });
});
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
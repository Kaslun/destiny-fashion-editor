import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createGearMaterials } from "./gearMaterial";
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

describe("createGearMaterials — detail-diffuse gate (Nighthawk weave fix)", () => {
  // A resolved detail texture + base diffuse triggers the detail branch.
  const tex = () => new THREE.Texture();
  const dyesWithDetail = {
    0: {
      primary: new THREE.Color(0xffffff),
      secondary: new THREE.Color(0xffffff),
      roughness: 0.6, metalness: 0,
      emissive: new THREE.Color(0, 0, 0),
      secondaryEmissive: new THREE.Color(0, 0, 0),
      detailDiffuseName: "x_weave_dif", detailNormalName: null,
      detailTransform: [1, 1, 0, 0] as [number, number, number, number],
      cloth: false,
      detailDiffuse: tex(),
    },
  };

  function fragmentFor(plated: boolean): string {
    const maps = { diffuse: tex(), gearstack: tex() };
    const mats = createGearMaterials(
      [{ dyeIndex: 0, decal: false }],
      dyesWithDetail as any,
      maps as any,
      { useGearstack: true, applyDye: true, plated },
    );
    const m = mats[0] as THREE.MeshStandardMaterial;
    const shader: any = { uniforms: {}, fragmentShader: `
      #include <map_fragment>
      #include <normal_fragment_maps>
      #include <roughnessmap_fragment>
      #include <metalnessmap_fragment>
      #include <emissivemap_fragment>` };
    (m.onBeforeCompile as any)?.(shader);
    return shader.fragmentShader;
  }

  it("non-plated item injects the detail-diffuse multiply (vest keeps its weave)", () => {
    expect(fragmentFor(false)).toContain("diffuseColor.rgb *= detail");
  });

  it("plated baked-art item does NOT inject detail diffuse (Nighthawk: no weave over gold/emblem)", () => {
    expect(fragmentFor(true)).not.toContain("diffuseColor.rgb *= detail");
  });
});
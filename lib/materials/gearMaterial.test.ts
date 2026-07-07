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

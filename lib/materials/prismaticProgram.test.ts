import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { parseRenderMetadata, lod0Parts } from "../geometry/renderMetadata";
import { parseDyes } from "../bungie/parseGearDyes";
import { dyeSetFromGearDyes } from "./gearDye";
import { createGearMaterials, isPatternGroup } from "./gearMaterial";
import fixture from "./fixtures/prismatic-program.json";

const meshes = parseRenderMetadata(JSON.stringify(fixture)).meshes;
const dyes = dyeSetFromGearDyes(parseDyes(fixture.default_dyes));
const groups = meshes.map((mesh) => lod0Parts(mesh).filter((p) => p.renderStage === 0).map((p) => ({
  dyeIndex: p.gearDyeChangeColorIndex, decal: p.decal, renderStage: p.renderStage,
  shaderType: p.shaderType, patternTextures: p.staticTextures,
})));

describe("prismatic surface program", () => {
  it.each(groups.map((g, i) => ({ groups: g, variant: i })))
  ("separates coating from ordinary emission on exported mesh $variant", ({ groups }) => {
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every(isPatternGroup)).toBe(true);
    const maps = { diffuse: new THREE.Texture(), gearstack: new THREE.Texture(),
      patternNoise: new THREE.Texture(), patternRipple: new THREE.Texture() };
    const materials = createGearMaterials(groups, dyes, maps, { applyDye: true, useGearstack: true });
    for (const material of materials) {
      expect(material.transparent).toBe(false);
      expect(material.userData.destiny.emissionSource).toBe("prismatic-surface-mask");
      expect(material.userData.uniforms.uPatternTime.value).toBe(0);
    }
    // The SAME exported red/white emission values must keep working for an
    // ordinary shader. Repetition or tint alone is never an emission gate.
    const [ordinary] = createGearMaterials([{ ...groups[0], patternTextures: [] }], dyes, maps,
      { applyDye: true, useGearstack: true });
    expect(ordinary.userData.destiny.emissionSource).toBe("gearstack-blue");
    expect(ordinary.userData.uniforms.uPatternTime).toBeUndefined();
  });

  it("requires the complete surface signature and supported stage/program", () => {
    const group = groups[0][0];
    for (const change of [{ renderStage: 7 }, { shaderType: 8 }, { shaderType: 42 },
      { patternTextures: group.patternTextures.slice(0, 1) },
      { patternTextures: [...group.patternTextures, "unknown_input"] }]) {
      expect(isPatternGroup({ ...group, ...change })).toBe(false);
    }
  });
});

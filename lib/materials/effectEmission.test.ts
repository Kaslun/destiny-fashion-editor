import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { parseRenderMetadata, lod0Parts } from "../geometry/renderMetadata";
import type { GroupInfo } from "../geometry/buildGeometry";
import { effectEmissionFallback } from "./effectEmission";
import { createGearMaterials } from "./gearMaterial";
import { dyeSetFromGearDyes } from "./gearDye";
import fixture from "./fixtures/emission-programs.json";

const groupsFor = (item: typeof fixture.items[number]): GroupInfo[] =>
  parseRenderMetadata(JSON.stringify(item.metadata)).meshes.flatMap((mesh) => lod0Parts(mesh).map((part) => ({
    dyeIndex: part.gearDyeChangeColorIndex, decal: part.decal, renderStage: part.renderStage,
    shaderType: part.shaderType, patternTextures: part.staticTextures,
  })));

describe("emission program evidence", () => {
  it.each(fixture.items.slice(0, 3))("recognizes the shared program on $name", (item) => {
    const groups = groupsFor(item);
    expect(effectEmissionFallback(groups)?.source).toBe("reference-hologram");
    const materials = createGearMaterials(groups, {}, { diffuse: new THREE.Texture(), gearstack: new THREE.Texture() },
      { useGearstack: true, applyDye: true });
    const projected = materials.filter((m) => m.userData.destiny?.effect === "digital-cloud");
    expect(projected.length).toBeGreaterThan(0);
    for (const mat of projected) {
      // Unlit VFX must explicitly enter the emissive attachment, with coverage.
      expect((mat as THREE.MeshBasicNodeMaterial).mrtNode?.has("emissive")).toBe(true);
      expect(mat.userData.destiny.emissionFallback).toBe("reference-hologram");
    }
    const shell = materials.find((m) => m instanceof THREE.MeshSSSNodeMaterial)!;
    expect(shell.userData.destiny.emissionFallback).toBe("reference-hologram");
  });

  it.each(fixture.items.slice(3))("does not recolor unrelated programs on $name", (item) => {
    expect(effectEmissionFallback(groupsFor(item))).toBeUndefined();
  });

  it("preserves an authored shader color instead of the reference fallback", () => {
    const dyes = dyeSetFromGearDyes({ "0": { primary: { emissive: [0, 1, 0], emissiveIntensity: 3 } } });
    const materials = createGearMaterials(groupsFor(fixture.items[0]), dyes, { gearstack: new THREE.Texture() });
    const symbol = materials.find((m) => m.userData.destiny?.effect === "digital-cloud")!;
    expect(symbol.userData.destiny.emissionFallback).toBeNull();
  });
});

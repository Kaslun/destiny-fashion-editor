import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { buildGeometryFromContainer, type GroupInfo } from "./buildGeometry";
import { isRayGlowGroup, prepareEffectUVs, transparentEffect } from "./transparentEffects";
import { createGearMaterials, advancePatternTime, hasAnimatedGlow } from "../materials/gearMaterial";
import fixture from "./fixtures/entheogenic-rays.json";
import spacewalk from "./fixtures/spacewalk-effects.json";
import hologram from "./fixtures/atlas-hologram-effects.json";
import { effectEmissionFallback } from "../materials/effectEmission";
import { readFileSync } from "node:fs";
import { decodeDataPng } from "./dataTexture";
import { decodeGearstack } from "../materials/destinyMaterialModel";

function build(variant = fixture.variants[0]) {
  const buffers = { ...variant.buffers,
    "render_metadata.js": Buffer.from(JSON.stringify(variant.metadata)).toString("base64") };
  const files = Object.entries(buffers).map(([name, encoded]) => {
    const data = new Uint8Array(Buffer.from(encoded, "base64"));
    return { name, data, type: 0, offset: 0, size: data.length };
  });
  return buildGeometryFromContainer({ version: 1, identifier: variant.file,
    files, byName: new Map(files.map((f) => [f.name, f])) }).meshes[0];
}

describe("exported ray glow", () => {
  it.each(fixture.variants)("recovers local ribbon coordinates in $file without changing armor coordinates", (variant) => {
    const { geometry, groups } = build(variant);
    const uv = [...geometry.getAttribute("uv").array];
    const indices = [...geometry.getIndex()!.array];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ renderStage: 7, shaderType: 8, dyeSource: "stage-part" });
    expect(isRayGlowGroup(groups[0])).toBe(true);
    expect(geometry.getIndex()!.count / 3).toBe(84);
    expect(prepareEffectUVs(geometry, groups)).toBe(true);
    const local = geometry.getAttribute("effectUv");
    expect(local.count).toBe(112);
    expect([...local.array].every((v) => v >= 0 && v <= 1)).toBe(true);
    // All 14 separate ribbons reach both ends, despite overlapping atlas islands.
    expect(Array.from({ length: local.count }, (_, i) => local.getY(i)).filter((v) => v === 1)).toHaveLength(56);
    expect([...geometry.getAttribute("uv").array]).toEqual(uv);
    expect([...geometry.getIndex()!.array]).toEqual(indices);
  });

  it("requires the transparent stage, shader selector and complete texture signature", () => {
    const { groups } = build();
    for (const change of [{ renderStage: 0 }, { shaderType: 7 }, { patternTextures: [] },
      { patternTextures: groups[0].patternTextures!.slice(0, 1) }]) {
      const group: GroupInfo = { ...groups[0], ...change };
      expect(isRayGlowGroup(group)).toBe(false);
    }
    const { geometry } = build();
    expect(prepareEffectUVs(geometry, [{ ...groups[0], renderStage: 0 }])).toBe(false);
    expect(geometry.getAttribute("effectUv")).toBeUndefined();
  });

  it("renders textured rays without lighting or depth writes and advances them independently of ability glow", () => {
    const { geometry, groups } = build();
    const effectTextures = new Map(groups[0].patternTextures!.map((n) => [n, new THREE.Texture()]));
    const [mat] = createGearMaterials(groups, {}, { effectTextures }, { sourceGeometry: geometry });
    expect(mat).toBeInstanceOf(THREE.MeshBasicNodeMaterial);
    expect(mat.visible).toBe(true);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.depthTest).toBe(true);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.side).toBe(THREE.FrontSide);
    expect((mat as THREE.MeshBasicNodeMaterial).opacityNode).toBeTruthy();
    expect((mat as THREE.MeshBasicNodeMaterial).mrtNode?.has("emissive")).toBe(true);
    const mesh = new THREE.Mesh(geometry, mat);
    expect(hasAnimatedGlow(mesh)).toBe(false);
    advancePatternTime(mesh, 0.25);
    expect(mat.userData.uniforms.uPatternTime.value).toBe(0.25);
  });

  it("never exposes solid carrier polygons when texture or coordinate inputs are missing", () => {
    const { geometry, groups } = build();
    const [missingMaps] = createGearMaterials(groups, {}, {}, { sourceGeometry: geometry });
    expect(missingMaps.visible).toBe(false);
    const effectTextures = new Map(groups[0].patternTextures!.map((n) => [n, new THREE.Texture()]));
    const [missingUV] = createGearMaterials(groups, {}, { effectTextures });
    expect(missingUV.visible).toBe(false);
    expect(missingUV.userData.destiny.missingUV).toBe(true);
  });
});

describe("shared transparent-effect routing", () => {
  it("recovers two distinct emissive silhouettes from Spacewalk's original atlas UVs", () => {
    const atlas = decodeDataPng(readFileSync(new URL("./fixtures/spacewalk-gearstack.png", import.meta.url)));
    expect([atlas.width, atlas.height]).toEqual([512, 256]);
    const { geometry } = build(spacewalk.variants[0]);
    const uv = geometry.getAttribute("uv");
    const counts: number[] = [];
    for (const start of [0, 4]) {
      const xs = Array.from({ length: 4 }, (_, i) => uv.getX(start + i) * 512);
      // Tile occupies the lower half of the 512x512 plate; no local-UV remap.
      const ys = Array.from({ length: 4 }, (_, i) => uv.getY(start + i) * 512 - 256);
      let lit = 0, dark = 0;
      for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++) {
        for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++) {
          const i = (y * atlas.width + x) * 4;
          const emission = decodeGearstack([atlas.data[i] / 255, atlas.data[i+1] / 255,
            atlas.data[i+2] / 255, atlas.data[i+3] / 255]).emissive;
          if (emission > 0) lit++; else dark++;
        }
      }
      expect(dark).toBeGreaterThan(lit);
      counts.push(lit);
    }
    expect(counts).toEqual([510, 480]);
  });
  it.each(spacewalk.variants)("recognizes Spacewalk's LOD01 effect in $file", (variant) => {
    const { geometry, groups } = build(variant);
    expect(geometry.getIndex()!.count).toBe(12);
    expect(groups).toHaveLength(1);
    expect(transparentEffect(groups[0])?.kind).toBe("digital-cloud");
    expect(prepareEffectUVs(geometry, groups)).toBe(true);
    const local = geometry.getAttribute("effectUv");
    // Two independently packed atlas islands must each recover all four corners.
    for (const start of [0, 4]) {
      const corners = new Set(Array.from({ length: 4 }, (_, i) => `${local.getX(start + i)},${local.getY(start + i)}`));
      expect(corners).toEqual(new Set(["0,0", "0,1", "1,0", "1,1"]));
    }
  });

  it("preserves the authored symbols even when armor dyes contain no emission", () => {
    const { geometry, groups } = build(spacewalk.variants[0]);
    const effectTextures = new Map(groups[0].patternTextures!.map((n) => [n, new THREE.Texture()]));
    const gearstack = new THREE.Texture();
    const [mat] = createGearMaterials(groups, {}, { effectTextures, gearstack }, { sourceGeometry: geometry });
    expect(mat).toBeInstanceOf(THREE.MeshBasicNodeMaterial);
    expect(mat.visible).toBe(true);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect((mat as THREE.MeshBasicNodeMaterial).opacityNode).toBeTruthy();
    expect((mat as THREE.MeshBasicNodeMaterial).colorNode).toBeTruthy();
    expect(mat.userData.destiny.effect).toBe("digital-cloud");
    expect(mat.userData.destiny.coverageSource).toBe("gearstack-blue");
    const [staticSymbols] = createGearMaterials(groups, {}, { gearstack }, { sourceGeometry: geometry });
    expect(staticSymbols.visible).toBe(true);
    expect(staticSymbols.userData.destiny.missingAnimationTextures).toBe(true);
    const [missing] = createGearMaterials(groups, {}, {}, { sourceGeometry: geometry });
    expect(missing.visible).toBe(false);
    expect(missing.userData.destiny.missingTextures).toBe(true);
  });

  it("requires the whole cloud signature and never matches an opaque draw", () => {
    const { groups } = build(spacewalk.variants[0]);
    expect(transparentEffect({ ...groups[0], renderStage: 0 })).toBeUndefined();
    expect(transparentEffect({ ...groups[0], patternTextures: groups[0].patternTextures!.slice(0, 1) })).toBeUndefined();
    const [opaque] = createGearMaterials([{ ...groups[0], renderStage: 0 }], {});
    expect(opaque.visible).toBe(true);
    expect(opaque.transparent).toBe(false);
  });

  it("keeps unrecognized transparent programs out of the solid armor path", () => {
    for (const shaderType of [-1, 7, 8, 42]) {
      const [mat] = createGearMaterials([{ dyeIndex: 0, decal: false, renderStage: 7,
        shaderType, patternTextures: ["unrecognized_effect"] }], {});
      expect(mat.visible).toBe(false);
      expect(mat.depthWrite).toBe(false);
      expect(mat.userData.destiny.unsupportedEffect).toBe(true);
      expect(mat.userData.destiny.textures).toEqual(["unrecognized_effect"]);
    }
  });
});

describe("atlas-colored holograms", () => {
  it("finds emissive strokes and transparent gaps inside the original emblem UV region", () => {
    const atlas = decodeDataPng(readFileSync(new URL("./fixtures/atlas-hologram-gearstack.png", import.meta.url)));
    const { geometry } = build(hologram.variants[0]);
    const uv = geometry.getAttribute("uv");
    const xs = Array.from({ length: uv.count }, (_, i) => uv.getX(i) * 512);
    const ys = Array.from({ length: uv.count }, (_, i) => uv.getY(i) * 512 - 256);
    let strokes = 0, gaps = 0;
    for (let y = Math.ceil(Math.min(...ys)); y < Math.floor(Math.max(...ys)); y++) {
      for (let x = Math.ceil(Math.min(...xs)); x < Math.floor(Math.max(...xs)); x++) {
        expect(x >= 0 && x < atlas.width && y >= 0 && y < atlas.height).toBe(true);
        const blue = atlas.data[(y * atlas.width + x) * 4 + 2];
        if (blue > 40) strokes++; else gaps++;
      }
    }
    expect(strokes).toBeGreaterThan(500);
    expect(gaps).toBeGreaterThan(strokes);
  });

  it.each(hologram.variants)("restores the exported emblem in $file", (variant) => {
    const { geometry, groups } = build(variant);
    expect(groups).toHaveLength(1);
    expect(transparentEffect(groups[0])).toMatchObject({ kind: "atlas-hologram" });
    const originalUV = [...geometry.getAttribute("uv").array];
    expect(prepareEffectUVs(geometry, groups)).toBe(true);
    expect([...geometry.getAttribute("uv").array]).toEqual(originalUV);
    expect(geometry.getIndex()!.count).toBeGreaterThan(12);
    const effectTextures = new Map(groups[0].patternTextures!.map((n) => [n, new THREE.Texture()]));
    const [mat] = createGearMaterials(groups, {}, {
      effectTextures, diffuse: new THREE.Texture(), gearstack: new THREE.Texture(),
    }, { sourceGeometry: geometry });
    expect(mat.visible).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.userData.destiny).toMatchObject({ effect: "atlas-hologram", colorSource: "diffuse-atlas",
      coverageSource: "gearstack-blue", missingAnimationTextures: false, emissionFallback: null });
    expect((mat as THREE.MeshBasicNodeMaterial).mrtNode?.has("emissive")).toBe(true);
    // Its color must not trigger Spacewalk's estimated tint on the armor shell.
    expect(effectEmissionFallback(groups)).toBeUndefined();
  });

  it("requires both atlas maps, but retains the emblem when modulation textures are missing", () => {
    const { geometry, groups } = build(hologram.variants[0]);
    for (const maps of [{}, { diffuse: new THREE.Texture() }, { gearstack: new THREE.Texture() }]) {
      const [mat] = createGearMaterials(groups, {}, maps, { sourceGeometry: geometry });
      expect(mat.visible).toBe(false);
      expect(mat.userData.destiny.missingTextures).toBe(true);
    }
    const [mat] = createGearMaterials(groups, {}, { diffuse: new THREE.Texture(), gearstack: new THREE.Texture() });
    expect(mat.visible).toBe(true);
    expect(mat.userData.destiny.missingAnimationTextures).toBe(true);
  });

  it("rejects partial, opaque and unknown extended signatures", () => {
    const { groups } = build(hologram.variants[0]);
    for (const change of [{ renderStage: 0 }, { shaderType: 7 },
      { patternTextures: groups[0].patternTextures!.slice(0, 1) },
      { patternTextures: [...groups[0].patternTextures!, "unknown_program_input"] }]) {
      expect(transparentEffect({ ...groups[0], ...change })).toBeUndefined();
    }
  });
});

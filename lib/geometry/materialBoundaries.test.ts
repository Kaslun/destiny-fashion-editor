import { describe, expect, it } from "vitest";
import { reconstructMaterialBoundaries } from "./materialBoundaries";
import type { RgbaImage } from "./dataTexture";

const row = (pixels: number[][]): RgbaImage => ({ width: pixels.length, height: 1, data: new Uint8Array(pixels.flat()) });
const gray = (values: number[]) => row(values.map((v) => [v, v, v, 255]));
const channel = (im: RgbaImage, c: number) => Array.from({ length: im.width }, (_, i) => im.data[i * 4 + c]);
const source = row([[255, 30, 32, 0], [255, 160, 32, 220]]);

describe("alpha-led, multi-channel material boundaries", () => {
  it("uses a corroborated higher-resolution edge without blending dielectric into dyed material", () => {
    const result = reconstructMaterialBoundaries(source, gray([0, 0, 0, 255]));
    expect(channel(result.image, 3)).toEqual([0, 0, 0, 220]);
    expect(channel(result.image, 1)).toEqual([30, 30, 30, 160]);
    expect(result.estimatedTexels).toBe(1);
  });
  it("does not infer boundaries from diffuse color alone", () => {
    const sameGloss = row([[255, 80, 32, 0], [255, 80, 32, 220]]);
    const result = reconstructMaterialBoundaries(sameGloss, gray([0, 0, 0, 255]));
    expect(channel(result.image, 3)).toEqual([0, 0, 220, 220]);
    expect(result.estimatedTexels).toBe(0);
  });
  it("accepts normal detail as independent boundary evidence", () => {
    const sameGloss = row([[255, 80, 32, 0], [255, 80, 32, 220]]);
    const normals = row([[128,128,255,255], [128,128,255,255], [128,128,255,255], [240,128,255,255]]);
    expect(channel(reconstructMaterialBoundaries(sameGloss, gray([0,0,0,255]), normals).image, 3))
      .toEqual([0,0,0,220]);
  });
  it("keeps undecidable alpha classes sharp when color supplies no evidence", () => {
    const result = reconstructMaterialBoundaries(source, gray([128,128,128,128]));
    expect(channel(result.image, 3)).toEqual([0,0,220,220]);
    expect(result.estimatedTexels).toBe(0);
  });
  it("rejects a color/gloss estimate contradicted by the normal boundary", () => {
    const normals = row([[128,128,255,255], [128,128,255,255], [240,128,255,255], [240,128,255,255]]);
    expect(reconstructMaterialBoundaries(source, gray([0,0,0,255]), normals).estimatedTexels).toBe(0);
  });
  it("never fabricates metalness at a dielectric/dyed seam", () => {
    for (const a of [40,48,128,255]) {
      const result = reconstructMaterialBoundaries(row([[255,80,32,0],[255,80,32,a]]), gray([120,120,120,120]));
      expect(channel(result.image, 3)).toEqual([0,0,a,a]);
    }
  });
  it("preserves smooth wear inside the dyed range without inventing slot bands", () => {
    const result = reconstructMaterialBoundaries(row([[255,80,32,190],[255,80,32,210]]), gray([128,128,128,128]));
    expect(channel(result.image, 3)).toEqual([190,195,205,210]);
    expect(result.estimatedTexels).toBe(0);
  });
  it("does not turn cutouts, emissive marks, or deep AO into estimated material regions", () => {
    for (const [r,b] of [[255,0],[255,128],[16,32]]) {
      const result = reconstructMaterialBoundaries(row([[r,30,b,0],[r,160,b,220]]), gray([0,0,0,255]));
      expect(result.estimatedTexels).toBe(0);
    }
  });
  it("does not interpolate packed opacity with emission", () => {
    const result = reconstructMaterialBoundaries(row([[255,80,0,200],[255,80,255,200]]), gray([128,128,128,128]));
    expect(channel(result.image, 2)).toEqual([0,0,255,255]);
  });
  it("retains the source when aligned high-resolution evidence is unavailable", () => {
    expect(reconstructMaterialBoundaries(source).image).toBe(source);
    expect(reconstructMaterialBoundaries(source, gray([100,100])).image).toBe(source);
    expect(reconstructMaterialBoundaries(source, gray([100])).image).toBe(source);
  });
});

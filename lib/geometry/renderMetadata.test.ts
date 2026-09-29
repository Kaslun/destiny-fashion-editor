import { describe, it, expect } from "vitest";
import { parseRenderMetadata, lod0Parts } from "./renderMetadata";
import corpus from "./fixtures/material-parts.json";

/** Minimal synthetic render_metadata.js payload with one mesh + given stage parts. */
function metadataJson(stageParts: unknown[]): string {
  return JSON.stringify({
    render_model: {
      render_meshes: [
        {
          stage_part_list: stageParts,
        },
      ],
    },
  });
}

describe("parseRenderMetadata — stage part shader field", () => {
  it("parses shaderType + staticTextures from a stage part's shader object", () => {
    const json = metadataJson([
      {
        start_index: 0,
        index_count: 10,
        gear_dye_change_color_index: 0,
        flags: 0,
        shader: {
          type: 7,
          static_textures: [
            "3107841013_vfx_warpmap_noise_a",
            "3107841013_vfx_warpmap_ripple_a",
          ],
        },
      },
    ]);
    const meta = parseRenderMetadata(json);
    const part = meta.meshes[0].stageParts[0];
    expect(part.shaderType).toBe(7);
    expect(part.staticTextures).toEqual([
      "3107841013_vfx_warpmap_noise_a",
      "3107841013_vfx_warpmap_ripple_a",
    ]);
  });

  it("defaults shaderType to -1 and staticTextures to [] when the shader key is absent", () => {
    const json = metadataJson([
      {
        start_index: 0,
        index_count: 10,
        gear_dye_change_color_index: 0,
        flags: 0,
      },
    ]);
    const meta = parseRenderMetadata(json);
    const part = meta.meshes[0].stageParts[0];
    expect(part.shaderType).toBe(-1);
    expect(part.staticTextures).toEqual([]);
  });

  it("defaults staticTextures to [] when shader.static_textures is missing or not an array of strings", () => {
    const json = metadataJson([
      { start_index: 0, index_count: 1, flags: 0, shader: { type: 7 } },
      { start_index: 1, index_count: 1, flags: 0, shader: { type: 7, static_textures: null } },
      {
        start_index: 2,
        index_count: 1,
        flags: 0,
        shader: { type: 7, static_textures: [1, 2, "ok"] },
      },
    ]);
    const meta = parseRenderMetadata(json);
    const [a, b, c] = meta.meshes[0].stageParts;
    expect(a.staticTextures).toEqual([]);
    expect(b.staticTextures).toEqual([]);
    expect(c.staticTextures).toEqual(["ok"]);
  });

  it("ordinary opaque parts (shader.type set, no static_textures) parse like a real corpus item — e.g. Celestial Nighthawk", () => {
    const json = metadataJson([
      {
        start_index: 0,
        index_count: 100,
        gear_dye_change_color_index: 0,
        flags: 0,
        shader: { type: 7 },
      },
    ]);
    const meta = parseRenderMetadata(json);
    expect(meta.meshes[0].stageParts[0].shaderType).toBe(7);
    expect(meta.meshes[0].stageParts[0].staticTextures).toEqual([]);
  });
});

describe("material pass and LOD separation", () => {
  const part = (start: number, count: number, lod = 0, dye = 0, flags = 0) => ({
    start_index: start, index_count: count, lod_category: lod,
    gear_dye_change_color_index: dye, flags,
  });
  it("keeps every category containing LOD zero, not just the lowest enum", () => {
    const mesh = parseRenderMetadata(metadataJson([0, 1, 2, 3, 4, 7, 9, 10].map((lod) => part(lod * 3, 3, lod)))).meshes[0];
    expect(lod0Parts(mesh).map((p) => p.lodCategory)).toEqual([0, 1, 2, 3]);
  });
  it("selects the finest available LOD when zero is absent", () => {
    const mesh = parseRenderMetadata(metadataJson([4, 5, 6, 7, 8, 9].map((lod) => part(lod * 3, 3, lod)))).meshes[0];
    expect(lod0Parts(mesh).map((p) => p.lodCategory)).toEqual([4, 5, 6]);
  });
  it("isolates shadow copies and preserves intentional overlay ranges", () => {
    const mesh = parseRenderMetadata(JSON.stringify({render_meshes: [{
      stage_part_offsets: [0, 2, 3, 3, 4],
      stage_part_list: [part(0, 3, 0, 0, 8), part(3, 3, 1, 2), part(0, 3, 2, 6), part(0, 6, 0, 4)],
    }]})).meshes[0];
    expect(lod0Parts(mesh).map((p) => [p.renderStage, p.gearDyeChangeColorIndex, p.decal]))
      .toEqual([[0, 0, false], [0, 2, false], [1, 6, true]]);
  });
  it("keeps separate adjacent slots and deduplicates repeated draw ranges", () => {
    const mesh = parseRenderMetadata(metadataJson([part(0, 3, 3, 2), part(0, 3, 0, 4), part(3, 3, 1, 4)])).meshes[0];
    expect(lod0Parts(mesh).map((p) => p.gearDyeChangeColorIndex)).toEqual([2, 4]);
  });
  for (const item of corpus.items) {
    it(`preserves authored material passes: ${item.name}`, () => {
      const mesh = parseRenderMetadata(JSON.stringify(item)).meshes[0];
      const selected = lod0Parts(mesh);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.every((p) => p.renderStage === 0 || p.renderStage === 7)).toBe(true);
      expect(selected.every((p) => !p.decal)).toBe(true);
      if (item.name === "Cover of the Exile") expect(selected.map((p) => p.gearDyeChangeColorIndex)).toEqual([3]);
      if (item.name === "Relativism cloth") {
        expect(selected).toHaveLength(2);
        expect(selected.every((p) => p.lodCategory === 3 && p.flags === 16392)).toBe(true);
      }
      if (item.name === "The Sixth Coyote") {
        expect(new Set(selected.map((p) => p.gearDyeChangeColorIndex))).toEqual(new Set([2, 4]));
      }
    });
  }
});

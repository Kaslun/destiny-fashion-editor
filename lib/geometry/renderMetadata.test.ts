import { describe, it, expect } from "vitest";
import { parseRenderMetadata } from "./renderMetadata";

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

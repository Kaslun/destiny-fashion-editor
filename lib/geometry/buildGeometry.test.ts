import { describe, expect, it } from "vitest";
import { buildGeometryFromContainer } from "./buildGeometry";
import type { TgxmContainer, TgxmFile } from "./tgxm";

describe("detail texture coordinates", () => {
  it("retains TEXCOORD2 independently of atlas UV scale and ignores TEXCOORD1", () => {
    const semantic = (name: string, index: number, components: number) => ({
      semantic: `_tfx_vb_semantic_${name}`, semantic_index: index,
      type: `_vertex_format_attribute_float${components}`, normalized: false,
    });
    const metadata = { render_model: { render_meshes: [{
      texcoord_scale: [0.5, 0.5], texcoord_offset: [0.25, 0.25],
      stage_part_vertex_stream_layout_definitions: [{ formats: [{ elements: [
        semantic("position", 0, 3), semantic("texcoord", 1, 2),
        semantic("texcoord", 0, 2), semantic("texcoord", 2, 2),
      ] }] }],
      stage_part_list: [{ start_index: 0, index_count: 3, primitive_type: 3, lod_category: 0, gear_dye_change_color_index: 1 }],
    }] } };
    const vertex = new Float32Array([
      0, 0, 0, 99, 99, 0, 0, 2, 3,
      1, 0, 0, 99, 99, 1, 0, 4, 5,
      0, 1, 0, 99, 99, 0, 1, 6, 7,
    ]);
    const file = (name: string, data: Uint8Array): TgxmFile => ({ name, data, offset: 0, type: 0, size: data.length });
    const files = [
      file("render_metadata.js", new TextEncoder().encode(JSON.stringify(metadata))),
      file("0.0.vertexbuffer.tgx", new Uint8Array(vertex.buffer)),
      file("0.indexbuffer.tgx", new Uint8Array(new Uint16Array([0, 1, 2]).buffer)),
    ];
    const container: TgxmContainer = { version: 1, identifier: "detail-uv", files, byName: new Map(files.map((f) => [f.name, f])) };
    const { geometry, groups } = buildGeometryFromContainer(container).meshes[0];
    expect([...geometry.getAttribute("uv").array]).toEqual([0.25, 0.25, 0.75, 0.25, 0.25, 0.75]);
    expect([...geometry.getAttribute("uv1").array]).toEqual([2, 3, 4, 5, 6, 7]);
    expect(groups[0].dyeIndex).toBe(1);
  });
});

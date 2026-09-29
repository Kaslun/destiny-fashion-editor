import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { buildGeometryFromContainer } from "./buildGeometry";
import type { TgxmContainer, TgxmFile } from "./tgxm";
import corpus from "./fixtures/vertex-materials.json";

function build(words: number[], indices: Uint8Array, parts: unknown[], normalType = "short4", stageOffsets?: number[]) {
  const short = normalType === "short4", stride = short ? 24 : 32;
  const vertices = new Uint8Array(words.length * stride), view = new DataView(vertices.buffer);
  words.forEach((word, i) => {
    view.setFloat32(i * stride, i, true);
    if (short) {
      view.setInt16(i * stride + 20, 32767, true); // normal Z
      view.setUint16(i * stride + 22, word, true);
    } else {
      view.setFloat32(i * stride + 24, 1, true);
      view.setFloat32(i * stride + 28, word, true);
    }
  });
  const metadata = { render_meshes: [{
    stage_part_offsets: stageOffsets,
    stage_part_list: parts,
    stage_part_vertex_stream_layout_definitions: [{ formats: [{ elements: [
      { semantic: "_tfx_vb_semantic_position", type: "_vertex_format_attribute_float4" },
      { semantic: "_tfx_vb_semantic_normal", type: `_vertex_format_attribute_${normalType}`, normalized: short },
    ] }] }],
  }] };
  const file = (name: string, data: Uint8Array): TgxmFile => ({ name, data, offset: 0, type: 0, size: data.length });
  const files = [file("render_metadata.js", new TextEncoder().encode(JSON.stringify(metadata))),
    file("0.0.vertexbuffer.tgx", vertices), file("0.indexbuffer.tgx", indices)];
  const container: TgxmContainer = { version: 1, identifier: "material-test", files, byName: new Map(files.map((f) => [f.name, f])) };
  return buildGeometryFromContainer(container).meshes[0];
}
const indexBytes = (indices: number[]) => new Uint8Array(new Uint16Array(indices).buffer);
const part = (start = 0, count = 3, dye = 3, primitive = 5) => ({
  start_index: start, index_count: count, gear_dye_change_color_index: dye,
  primitive_type: primitive, lod_category: 0, flags: 16384,
  shader: { static_textures: ["keep-this-reference"] },
});

describe("packed vertex materials", () => {
  for (const item of corpus.items) {
    it(`recovers actual material boundaries: ${item.name}`, () => {
      const words = item.normalWordsRle.flatMap(([word, count]) => Array<number>(count).fill(word));
      const { geometry, groups } = build(words, unzlibSync(Buffer.from(item.indices, "base64")), item.parts);
      const counts: Record<number, number> = {};
      for (const [i, group] of groups.entries()) {
        expect(group.dyeSource).toBe("vertex-normal-w");
        const draw = geometry.groups[i];
        counts[group.dyeIndex] = (counts[group.dyeIndex] ?? 0) + draw.count / 3;
        for (let j = draw.start; j < draw.start + draw.count; j++) {
          expect(words[geometry.index!.getX(j)] & 7).toBe(group.dyeIndex);
        }
      }
      if (item.name.startsWith("Cover")) expect(counts).toEqual({ 0: 2052, 3: 332, 4: 278 });
      if (item.name === "The Sixth Coyote") expect(counts).toEqual({ 0: 316, 1: 784, 2: 1086, 3: 1266, 4: 1434, 5: 1744 });
      if (item.name === "Relativism shell") expect(counts).toEqual({ 0: 5668 });
    });
  }

  it("preserves strip winding/restarts and normals while separating zero and flagged IDs", () => {
    const { geometry, groups } = build([0, 0, 0, 0, 0x800c, 4, 0x800c],
      indexBytes([0, 1, 2, 3, 65535, 4, 5, 6]), [part(0, 8)]);
    expect(Array.from(geometry.index!.array)).toEqual([0, 1, 2, 1, 3, 2, 4, 5, 6]);
    expect(groups.map((g) => [g.dyeIndex, g.dyeSource])).toEqual([[0, "vertex-normal-w"], [4, "vertex-normal-w"]]);
    expect(groups.every((g) => g.flags === 16384 && g.patternTextures?.[0] === "keep-this-reference")).toBe(true);
    expect(Array.from(geometry.getAttribute("normal").array)).toEqual(Array(7).fill([0, 0, 1]).flat());
  });

  it("does not vote or interpolate when a triangle has conflicting IDs", () => {
    const { groups } = build([0, 0, 4], indexBytes([0, 1, 2]), [part()]);
    expect(groups[0]).toMatchObject({ dyeIndex: 3, dyeSource: "stage-part" });
  });

  it("keeps triangle-list and float-normal assignments from their draw calls", () => {
    for (const [primitive, normalType] of [[3, "short4"], [5, "float4"]] as const) {
      const { groups } = build([4, 4, 4], indexBytes([0, 1, 2]), [part(0, 3, 2, primitive)], normalType);
      expect(groups[0]).toMatchObject({ dyeIndex: 2, dyeSource: "stage-part" });
    }
  });

  it("retains pass boundaries and overlay assignment when geometry is reused", () => {
    const { groups } = build([0, 0, 0], indexBytes([0, 1, 2]), [part(), part(0, 3, 6)], "short4", [0, 1, 2]);
    expect(groups.map((g) => [g.dyeIndex, g.renderStage, g.decal, g.dyeSource])).toEqual([
      [0, 0, false, "vertex-normal-w"], [6, 1, true, "stage-part"],
    ]);
  });
});

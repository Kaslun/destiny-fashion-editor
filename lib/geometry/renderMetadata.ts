/**
 * Parser for `render_metadata.js` (JSON despite the extension).
 *
 * This describes how to turn the raw vertex/index buffers in a geometry
 * container into drawable meshes: the vertex stream layout (which byte ranges
 * are position / normal / texcoord and in what numeric format), the position &
 * texcoord scale/offset used to unpack fixed-point values, and a
 * `stage_part_list` of draw calls tagged with LOD category and dye slot.
 *
 * Bungie never fully documented the D2 mobile variant, so we keep `raw` around
 * and read fields defensively — the POC dumps `summarize()` so we can confirm
 * the real key names against a live item and tighten this up empirically.
 */

// Primitive types: 3 = triangle list (no special handling), 5 = triangle strip
// (expanded in buildGeometry). Highest-detail LOD is selected per-mesh in
// lod0Parts().
export const PRIMITIVE_TRIANGLES = 3;
export const PRIMITIVE_TRIANGLE_STRIP = 5;

export interface VertexElement {
  semantic: string;
  semanticIndex: number;
  type: string;
  normalized: boolean;
  /** number of components (short4 -> 4) */
  components: number;
  /** bytes per component */
  componentBytes: number;
  /** signed/unsigned + int/float */
  numeric: "int" | "uint" | "float";
  /** byte offset within the stream vertex, filled during layout resolution */
  offset: number;
}

export interface VertexStreamLayout {
  stride: number;
  elements: VertexElement[];
}

export interface StagePart {
  startIndex: number;
  indexCount: number;
  primitiveType: number;
  lodCategory: number;
  gearDyeChangeColorIndex: number;
  flags: number;
  /** transparent decal pass (flag 0x8): additive blend, black = transparent */
  decal: boolean;
  raw: Record<string, unknown>;
}

export interface RenderMesh {
  index: number;
  stageParts: StagePart[];
  streams: VertexStreamLayout[];
  positionScale: number[] | null;
  positionOffset: number[] | null;
  texcoordScale: number[] | null;
  texcoordOffset: number[] | null;
  raw: Record<string, unknown>;
}

/**
 * Texture plating: mobile gear splits its material maps into small sub-textures
 * that get composited onto a fixed-size plate (atlas) at exact positions — the
 * mesh UVs address the *assembled plate*, not any individual image. Rendering a
 * raw sub-texture directly produces smeared/misplaced texturing.
 */
export interface PlatePlacement {
  /** entry name inside the item's texture containers (e.g. ..._gbit_384_192_0) */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TexturePlate {
  size: [number, number];
  placements: PlatePlacement[];
}

export interface TexturePlateSet {
  diffuse?: TexturePlate;
  normal?: TexturePlate;
  gearstack?: TexturePlate;
  /** per-pixel dye-slot mask plate (which dye slot each texel belongs to) */
  dyeslot?: TexturePlate;
}

export interface RenderMetadata {
  meshes: RenderMesh[];
  /** assembled-atlas definitions (null when the item ships no plates) */
  plates: TexturePlateSet | null;
  raw: unknown;
}

// --- element type table ------------------------------------------------------
interface TypeInfo {
  components: number;
  componentBytes: number;
  numeric: "int" | "uint" | "float";
}

function typeInfo(type: string): TypeInfo {
  const t = type.replace("_vertex_format_attribute_", "");
  const m = t.match(/^(u?)(byte|short|int|float|nibble)(\d)$/);
  if (!m) return { components: 4, componentBytes: 1, numeric: "uint" };
  const [, unsigned, base, count] = m;
  const bytes = base === "byte" ? 1 : base === "short" ? 2 : 4;
  const numeric: TypeInfo["numeric"] =
    base === "float" ? "float" : unsigned ? "uint" : "int";
  return { components: Number(count), componentBytes: bytes, numeric };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

/** lod_category can be a number or an object like { value, name }. */
function lodValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "value" in v) {
    return num((v as { value: unknown }).value);
  }
  return -1;
}

function parseStreams(meshRaw: Record<string, unknown>): VertexStreamLayout[] {
  const defs =
    (meshRaw.stage_part_vertex_stream_layout_definitions as unknown[]) ?? [];
  const streams: VertexStreamLayout[] = [];

  for (const def of defs) {
    const formats = ((def as Record<string, unknown>).formats as unknown[]) ?? [];
    for (const fmt of formats) {
      const elementsRaw =
        ((fmt as Record<string, unknown>).elements as unknown[]) ?? [];
      let offset = 0;
      const elements: VertexElement[] = elementsRaw.map((e) => {
        const el = e as Record<string, unknown>;
        const type = String(el.type ?? "");
        const info = typeInfo(type);
        const element: VertexElement = {
          semantic: String(el.semantic ?? ""),
          semanticIndex: num(el.semantic_index),
          type,
          normalized: Boolean(el.normalized),
          components: info.components,
          componentBytes: info.componentBytes,
          numeric: info.numeric,
          offset,
        };
        offset += info.components * info.componentBytes;
        return element;
      });
      streams.push({ stride: offset, elements });
    }
  }
  return streams;
}

function parseStageParts(meshRaw: Record<string, unknown>): StagePart[] {
  const list = (meshRaw.stage_part_list as unknown[]) ?? [];
  return list.map((p) => {
    const part = p as Record<string, unknown>;
    const flags = num(part.flags);
    return {
      startIndex: num(part.start_index),
      indexCount: num(part.index_count),
      primitiveType: num(part.primitive_type, PRIMITIVE_TRIANGLES),
      lodCategory: lodValue(part.lod_category ?? part.lod_category_value),
      gearDyeChangeColorIndex: num(part.gear_dye_change_color_index, -1),
      flags,
      decal: (flags & FLAG_DECAL_PASS) !== 0,
      raw: part,
    };
  });
}

function numArray(v: unknown): number[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "number")
    ? (v as number[])
    : null;
}

function parsePlate(raw: unknown): TexturePlate | undefined {
  const p = raw as {
    plate_size?: number[];
    texture_placements?: {
      texture_tag_name?: string;
      position_x?: number;
      position_y?: number;
      texture_size_x?: number;
      texture_size_y?: number;
    }[];
  } | undefined;
  if (!p?.plate_size || !Array.isArray(p.texture_placements)) return undefined;
  const placements: PlatePlacement[] = p.texture_placements
    .filter((t) => typeof t.texture_tag_name === "string")
    .map((t) => ({
      name: t.texture_tag_name as string,
      x: num(t.position_x),
      y: num(t.position_y),
      w: num(t.texture_size_x),
      h: num(t.texture_size_y),
    }));
  if (placements.length === 0) return undefined;
  return { size: [num(p.plate_size[0], 512), num(p.plate_size[1], 512)], placements };
}

function parsePlates(data: Record<string, unknown>): TexturePlateSet | null {
  const set = (data.texture_plates as { plate_set?: Record<string, unknown> }[])?.[0]
    ?.plate_set;
  if (!set) return null;
  const plates: TexturePlateSet = {
    diffuse: parsePlate(set.diffuse),
    normal: parsePlate(set.normal),
    gearstack: parsePlate(set.gearstack),
    dyeslot: parsePlate(set.dyeslot),
  };
  return plates.diffuse || plates.normal || plates.gearstack ? plates : null;
}

export function parseRenderMetadata(json: string): RenderMetadata {
  const data = JSON.parse(json);

  // render_meshes can live at the top level or under render_model.
  const meshesRaw: unknown[] =
    data?.render_model?.render_meshes ?? data?.render_meshes ?? [];

  const meshes: RenderMesh[] = meshesRaw.map((m, index) => {
    const meshRaw = m as Record<string, unknown>;
    return {
      index,
      stageParts: parseStageParts(meshRaw),
      streams: parseStreams(meshRaw),
      positionScale: numArray(meshRaw.position_scale),
      positionOffset: numArray(meshRaw.position_offset),
      texcoordScale: numArray(meshRaw.texcoord_scale),
      texcoordOffset: numArray(meshRaw.texcoord_offset),
      raw: meshRaw,
    };
  });

  return { meshes, plates: parsePlates(data), raw: data };
}

// Stage-part flag bits (empirically derived from live D2 items). Bit 0x8 marks
// a transparent decal/glow pass — rendered additively (black = transparent),
// not skipped.
const FLAG_DECAL_PASS = 0x8;

/**
 * Stage parts that belong to LOD 0 (highest detail), without overlaps.
 *
 * `lod_category` values vary per mesh (e.g. {0,4,7,9} vs {1,8}); the lowest
 * value present is the highest-detail LOD. The list repeats the same index
 * ranges in several groupings (coarse whole-mesh parts alongside fine per-dye
 * parts); drawing both z-fights. We sort by (start asc, count asc) and keep
 * parts that don't overlap an already-kept range — fine-grained parts win and
 * coarse containers drop out. Decal parts are kept (flagged) and screened
 * separately since they intentionally overlay the opaque geometry.
 */
export function lod0Parts(mesh: RenderMesh): StagePart[] {
  const cats = mesh.stageParts.map((p) => p.lodCategory).filter((c) => c >= 0);
  const min = cats.length > 0 ? Math.min(...cats) : -1;
  const atLod = mesh.stageParts.filter((p) => min < 0 || p.lodCategory === min);

  const pickNonOverlapping = (parts: StagePart[]): StagePart[] => {
    const sorted = [...parts].sort(
      (a, b) => a.startIndex - b.startIndex || a.indexCount - b.indexCount,
    );
    const kept: StagePart[] = [];
    let coveredEnd = -1;
    for (const p of sorted) {
      if (p.startIndex < coveredEnd) continue; // overlaps a kept range
      kept.push(p);
      coveredEnd = p.startIndex + p.indexCount;
    }
    return kept;
  };

  return [
    ...pickNonOverlapping(atLod.filter((p) => !p.decal)),
    ...pickNonOverlapping(atLod.filter((p) => p.decal)),
  ];
}

/** Compact, human-readable summary for the POC debug dump. */
export function summarize(meta: RenderMetadata) {
  return {
    meshCount: meta.meshes.length,
    meshes: meta.meshes.map((mesh) => ({
      index: mesh.index,
      streamCount: mesh.streams.length,
      strides: mesh.streams.map((s) => s.stride),
      elements: mesh.streams.map((s) =>
        s.elements.map((e) => `${e.semantic}[${e.semanticIndex}]:${e.type}`),
      ),
      stagePartCount: mesh.stageParts.length,
      lodCategories: [...new Set(mesh.stageParts.map((p) => p.lodCategory))],
      hasPositionScale: !!mesh.positionScale,
      hasTexcoordScale: !!mesh.texcoordScale,
    })),
  };
}

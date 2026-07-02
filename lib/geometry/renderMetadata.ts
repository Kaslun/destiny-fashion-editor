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

export interface RenderMetadata {
  meshes: RenderMesh[];
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
    return {
      startIndex: num(part.start_index),
      indexCount: num(part.index_count),
      primitiveType: num(part.primitive_type, PRIMITIVE_TRIANGLES),
      lodCategory: lodValue(part.lod_category ?? part.lod_category_value),
      gearDyeChangeColorIndex: num(part.gear_dye_change_color_index, -1),
      flags: num(part.flags),
      raw: part,
    };
  });
}

function numArray(v: unknown): number[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "number")
    ? (v as number[])
    : null;
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

  return { meshes, raw: data };
}

// Stage-part flag bits (empirically derived from live D2 items). A mesh's
// index buffer is shared across many stage parts describing different LODs and
// render passes; without filtering they overlap and z-fight, and secondary
// passes throw spanning artifacts. Bit 0x8 marks a secondary/decal pass we skip
// for the main opaque render.
const FLAG_SECONDARY_PASS = 0x8;

/**
 * Stage parts that belong to LOD 0 (highest detail), deduplicated.
 *
 * `lod_category` values vary per mesh (e.g. {0,4,7,9} vs {1,8}); the lowest
 * value present is the highest-detail LOD. Among those we (a) drop secondary-
 * pass parts (flag 0x8) and (b) dedupe identical draw ranges, since the same
 * geometry is often listed multiple times for different passes/variants.
 */
export function lod0Parts(mesh: RenderMesh): StagePart[] {
  const cats = mesh.stageParts.map((p) => p.lodCategory).filter((c) => c >= 0);
  if (cats.length === 0) return mesh.stageParts;
  const min = Math.min(...cats);

  const pick = (allowSecondaryFilter: boolean): StagePart[] => {
    // Keep the largest draw range per start_index (overlapping ranges at the
    // same start are different LOD runs of the same geometry — take the finest).
    const byStart = new Map<number, StagePart>();
    for (const p of mesh.stageParts) {
      if (p.lodCategory !== min) continue;
      if (allowSecondaryFilter && (p.flags & FLAG_SECONDARY_PASS) !== 0) continue;
      const existing = byStart.get(p.startIndex);
      if (!existing || p.indexCount > existing.indexCount) byStart.set(p.startIndex, p);
    }
    return [...byStart.values()];
  };

  const selected = pick(true);
  // If flag filtering removed everything, retry without it (unknown flag scheme).
  return selected.length > 0 ? selected : pick(false);
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

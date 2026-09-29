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
  /** Render-stage index from stage_part_offsets, or null in legacy exports. */
  renderStage: number | null;
  /** Stage 1/2/6 overlay, independent of material and flag bits. */
  decal: boolean;
  /** part.shader.type — a shader-program selector. -1 when absent. Most
   * ordinary opaque parts carry a common id (e.g. 7) with no static_textures;
   * parts that reference named VFX textures (see staticTextures) use the same
   * ids to mean something more specific — see gearMaterial.ts isPatternGroup. */
  shaderType: number;
  /** part.shader.static_textures — named VFX texture references (e.g. a
   * noise/ripple warp-map pair driving Relativism's iridescent pattern).
   * Empty for ordinary opaque parts. Resolved to real textures by
   * loadGearModel.ts via the same by-name lookup used for detail maps. */
  staticTextures: string[];
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

function parseShaderStaticTextures(shader: unknown): string[] {
  const list = (shader as { static_textures?: unknown } | undefined)?.static_textures;
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
}

function parseStageParts(meshRaw: Record<string, unknown>): StagePart[] {
  const list = (meshRaw.stage_part_list as unknown[]) ?? [];
  const offsets = meshRaw.stage_part_offsets;
  const validOffsets = Array.isArray(offsets) && offsets.length > 1 && offsets[0] === 0 &&
    offsets.every((v, i) => Number.isInteger(v) && v >= 0 && v <= list.length && (i === 0 || v >= offsets[i - 1]));
  return list.map((p, index) => {
    const part = p as Record<string, unknown>;
    const flags = num(part.flags);
    const shader = part.shader as { type?: unknown } | undefined;
    const stage = validOffsets ? offsets.findIndex((start, i) => start <= index && index < offsets[i + 1]) : -1;
    const renderStage = stage < 0 ? null : stage;
    return {
      startIndex: num(part.start_index),
      indexCount: num(part.index_count),
      primitiveType: num(part.primitive_type, PRIMITIVE_TRIANGLES),
      lodCategory: lodValue(part.lod_category ?? part.lod_category_value),
      gearDyeChangeColorIndex: num(part.gear_dye_change_color_index, -1),
      flags,
      renderStage,
      decal: renderStage === 1 || renderStage === 2 || renderStage === 6,
      shaderType: num(shader?.type, -1),
      staticTextures: parseShaderStaticTextures(part.shader),
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

// Bungie's category names describe sets of LODs, not an ordering of parts.
const LOD_MASKS = [0b0001, 0b0011, 0b0111, 0b1111, 0b0010, 0b0110, 0b1110, 0b0100, 0b1100, 0b1000];
const VISIBLE_STAGES = new Set([0, 1, 2, 6, 7]);

/** Keep visible passes and every category covering the best available LOD.
 * Shadow/depth copies must never compete with authored material draw calls.
 * Repeated ranges within one pass keep the first authored record; identical
 * ranges across different visible passes are intentional overlays.
 */
export function lod0Parts(mesh: RenderMesh): StagePart[] {
  const visible = mesh.stageParts.filter((p) =>
    (p.renderStage === null || VISIBLE_STAGES.has(p.renderStage)) &&
    p.indexCount > 0 && p.startIndex >= 0 &&
    (p.lodCategory === -1 || LOD_MASKS[p.lodCategory] !== undefined));
  const lod = [0, 1, 2, 3].find((level) => visible.some((p) =>
    ((LOD_MASKS[p.lodCategory] ?? 1) & (1 << level)) !== 0)) ?? 0;
  const seen = new Set<string>();
  return visible.filter((p) => {
    if (((LOD_MASKS[p.lodCategory] ?? 1) & (1 << lod)) === 0) return false;
    const key = `${p.renderStage}:${p.startIndex}:${p.indexCount}:${p.primitiveType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      selectedMaterialParts: lod0Parts(mesh).map((p) => ({
        stage: p.renderStage, dyeIndex: p.gearDyeChangeColorIndex,
        start: p.startIndex, count: p.indexCount, lodCategory: p.lodCategory,
      })),
      hasPositionScale: !!mesh.positionScale,
      hasTexcoordScale: !!mesh.texcoordScale,
    })),
  };
}

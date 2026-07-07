/**
 * Turns a parsed TGXM geometry container + its render_metadata into Three.js
 * BufferGeometry objects (one per render mesh).
 *
 * Buffers inside the container follow a naming convention:
 *   `<mesh>.<stream>.vertexbuffer.tgx`   e.g. 0.0.vertexbuffer.tgx
 *   `<mesh>.indexbuffer.tgx`             e.g. 0.indexbuffer.tgx
 *
 * We decode the vertex streams according to the metadata's stream layout,
 * unpack fixed-point positions/uvs with the mesh scale+offset, and build an
 * index from the LOD-0 stage parts. Each stage part becomes a geometry group
 * (materialIndex = dye slot) so the material layer can dye parts independently.
 *
 * Exact fixed-point conventions for D2 mobile are partly undocumented; where a
 * mesh lacks scale/offset we fall back to normalized values and let the viewer
 * auto-frame. See renderMetadata.ts.
 */
import * as THREE from "three";
import type { TgxmContainer, TgxmFile } from "./tgxm";
import {
  parseRenderMetadata,
  lod0Parts,
  PRIMITIVE_TRIANGLE_STRIP,
  type RenderMesh,
  type VertexElement,
  type VertexStreamLayout,
  type RenderMetadata,
} from "./renderMetadata";
import { fileAsText, findRenderMetadata } from "./tgxm";

/** Primitive-restart sentinel for 16-bit triangle strips. */
const RESTART_INDEX = 0xffff;

const SEM_POSITION = "_tfx_vb_semantic_position";
const SEM_NORMAL = "_tfx_vb_semantic_normal";
const SEM_TEXCOORD = "_tfx_vb_semantic_texcoord";

export interface GroupInfo {
  /** gear_dye_change_color_index of the stage part (÷2 = dye slot) */
  dyeIndex: number;
  /** transparent decal pass — render additive (black = transparent) */
  decal: boolean;
  /**
   * Self-illuminated glow geometry (e.g. Nighthawk's eye) — the diffuse is a
   * bright emblem on black. Set by the loader from texture-region analysis;
   * rendered additively so the black surround is transparent.
   */
  glow?: boolean;
}

export interface BuiltMesh {
  geometry: THREE.BufferGeometry;
  /** per geometry group, index-aligned with geometry.groups. */
  groups: GroupInfo[];
}

export interface BuildResult {
  meshes: BuiltMesh[];
  metadata: RenderMetadata;
}

function dataViewOf(file: TgxmFile): DataView {
  return new DataView(file.data.buffer, file.data.byteOffset, file.data.byteLength);
}

function readComponent(
  view: DataView,
  byteOffset: number,
  el: VertexElement,
  component: number,
): number {
  const off = byteOffset + component * el.componentBytes;
  let raw: number;
  if (el.numeric === "float") {
    raw = view.getFloat32(off, true);
  } else if (el.componentBytes === 1) {
    raw = el.numeric === "uint" ? view.getUint8(off) : view.getInt8(off);
  } else if (el.componentBytes === 2) {
    raw = el.numeric === "uint" ? view.getUint16(off, true) : view.getInt16(off, true);
  } else {
    raw = el.numeric === "uint" ? view.getUint32(off, true) : view.getInt32(off, true);
  }
  if (el.normalized && el.numeric !== "float") {
    const bits = el.componentBytes * 8;
    const divisor = el.numeric === "uint" ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
    raw = raw / divisor;
  }
  return raw;
}

/** Locate a stream + element for a given semantic across all streams. */
function findSemantic(
  streams: VertexStreamLayout[],
  semantic: string,
): { streamIndex: number; element: VertexElement } | null {
  for (let s = 0; s < streams.length; s++) {
    const element = streams[s].elements.find((e) => e.semantic === semantic);
    if (element) return { streamIndex: s, element };
  }
  return null;
}

function findVertexFile(
  container: TgxmContainer,
  meshIndex: number,
  streamIndex: number,
): TgxmFile | null {
  return (
    container.byName.get(`${meshIndex}.${streamIndex}.vertexbuffer.tgx`) ??
    container.files.find(
      (f) => f.name.includes(`${meshIndex}.${streamIndex}`) && f.name.includes("vertexbuffer"),
    ) ??
    null
  );
}

function findIndexFile(container: TgxmContainer, meshIndex: number): TgxmFile | null {
  return (
    container.byName.get(`${meshIndex}.indexbuffer.tgx`) ??
    container.files.find(
      (f) => f.name.includes(`${meshIndex}.`) && f.name.includes("indexbuffer"),
    ) ??
    container.files.find((f) => f.name.includes("indexbuffer")) ??
    null
  );
}

function scaleOffset(
  value: number,
  component: number,
  scale: number[] | null,
  offset: number[] | null,
): number {
  const s = scale && component < scale.length ? scale[component] : 1;
  const o = offset && component < offset.length ? offset[component] : 0;
  return value * s + o;
}

function buildMesh(
  container: TgxmContainer,
  mesh: RenderMesh,
): BuiltMesh | null {
  if (mesh.streams.length === 0) return null;

  const posInfo = findSemantic(mesh.streams, SEM_POSITION);
  if (!posInfo) return null;
  const normalInfo = findSemantic(mesh.streams, SEM_NORMAL);
  const uvInfo = findSemantic(mesh.streams, SEM_TEXCOORD);

  // Load the vertex-stream buffers referenced by the layout.
  const streamViews: (DataView | null)[] = mesh.streams.map((_, s) => {
    const file = findVertexFile(container, mesh.index, s);
    return file ? dataViewOf(file) : null;
  });

  const posView = streamViews[posInfo.streamIndex];
  if (!posView) return null;

  const posStride = mesh.streams[posInfo.streamIndex].stride;
  const vertexCount = Math.floor(posView.byteLength / posStride);
  if (vertexCount === 0) return null;

  const positions = new Float32Array(vertexCount * 3);
  const normals = normalInfo ? new Float32Array(vertexCount * 3) : null;
  const uvs = uvInfo ? new Float32Array(vertexCount * 2) : null;

  // Float positions are already in Destiny's shared character space (Z-up); the
  // bounding_volume + position_offset confirm e.g. a helmet sits at z≈1.7 (head
  // height). position_scale/offset only decompress NORMALIZED (short/int)
  // positions — applying them to float coords collapses each piece into its own
  // tiny local box, which breaks multi-piece character assembly. So skip the
  // transform for float positions and keep the real shared-space coordinates.
  const posIsFloat = posInfo.element.numeric === "float";

  for (let v = 0; v < vertexCount; v++) {
    // position
    {
      const stride = mesh.streams[posInfo.streamIndex].stride;
      const base = v * stride + posInfo.element.offset;
      for (let c = 0; c < 3; c++) {
        const raw = readComponent(posView, base, posInfo.element, c);
        positions[v * 3 + c] = posIsFloat
          ? raw
          : scaleOffset(raw, c, mesh.positionScale, mesh.positionOffset);
      }
    }
    // normal
    if (normalInfo && normals) {
      const view = streamViews[normalInfo.streamIndex];
      if (view) {
        const stride = mesh.streams[normalInfo.streamIndex].stride;
        const base = v * stride + normalInfo.element.offset;
        for (let c = 0; c < 3; c++) {
          normals[v * 3 + c] = readComponent(view, base, normalInfo.element, c);
        }
      }
    }
    // texcoord0
    if (uvInfo && uvs) {
      const view = streamViews[uvInfo.streamIndex];
      if (view) {
        const stride = mesh.streams[uvInfo.streamIndex].stride;
        const base = v * stride + uvInfo.element.offset;
        const u = scaleOffset(
          readComponent(view, base, uvInfo.element, 0),
          0,
          mesh.texcoordScale,
          mesh.texcoordOffset,
        );
        const w = scaleOffset(
          readComponent(view, base, uvInfo.element, 1),
          1,
          mesh.texcoordScale,
          mesh.texcoordOffset,
        );
        // Destiny UVs are v-down with a top-left origin — the same convention
        // as the uploaded image rows when textures use flipY=false, so V passes
        // through unflipped. (Confirmed empirically: plate-atlas placements only
        // line up in v-down space; a 1-v flip mirrors all sampling vertically.)
        uvs[v * 2] = u;
        uvs[v * 2 + 1] = w;
      }
    }
  }

  // --- indices from LOD-0 stage parts ---
  const indexFile = findIndexFile(container, mesh.index);
  if (!indexFile) return null;
  const idxView = dataViewOf(indexFile);
  // 16-bit indices are standard for mobile; detect 32-bit only if needed.
  const sourceIndexCount = Math.floor(idxView.byteLength / 2);
  const readIndex = (i: number) => idxView.getUint16(i * 2, true);

  const combined: number[] = [];
  const groups: GroupInfo[] = [];
  const geometry = new THREE.BufferGeometry();

  for (const part of lod0Parts(mesh)) {
    const groupStart = combined.length;
    const end = Math.min(part.startIndex + part.indexCount, sourceIndexCount);

    if (part.primitiveType === PRIMITIVE_TRIANGLE_STRIP) {
      // Expand strip -> list. Bungie strips use 0xFFFF as a primitive-restart
      // sentinel; a triangle touching it (or a degenerate) is skipped, and
      // parity resets after each restart so winding stays correct.
      let stripStart = part.startIndex;
      for (let i = part.startIndex; i < end - 2; i++) {
        const a = readIndex(i);
        const b = readIndex(i + 1);
        const c = readIndex(i + 2);
        if (a === RESTART_INDEX || b === RESTART_INDEX || c === RESTART_INDEX) {
          if (c === RESTART_INDEX) stripStart = i + 3;
          else if (b === RESTART_INDEX) stripStart = i + 2;
          else stripStart = i + 1;
          continue;
        }
        if (a === b || b === c || a === c) continue; // degenerate
        if ((i - stripStart) % 2 === 0) combined.push(a, b, c);
        else combined.push(a, c, b);
      }
    } else {
      for (let i = part.startIndex; i < end; i++) combined.push(readIndex(i));
    }

    const groupCount = combined.length - groupStart;
    if (groupCount > 0) {
      geometry.addGroup(groupStart, groupCount, groups.length);
      groups.push({ dyeIndex: part.gearDyeChangeColorIndex, decal: part.decal });
    }
  }

  if (combined.length === 0) return null;

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(combined);
  if (!normals) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return { geometry, groups };
}

/**
 * Build all renderable meshes from a geometry container.
 * `render_metadata.js` is read from inside the container.
 */
export function buildGeometryFromContainer(container: TgxmContainer): BuildResult {
  const metaFile = findRenderMetadata(container);
  if (!metaFile) {
    throw new Error("Geometry container has no render_metadata");
  }
  const metadata = parseRenderMetadata(fileAsText(metaFile));

  const meshes: BuiltMesh[] = [];
  for (const mesh of metadata.meshes) {
    const built = buildMesh(container, mesh);
    if (built) meshes.push(built);
  }
  return { meshes, metadata };
}

/**
 * Browser-side gear model loader. Runs the full pipeline for one item hash:
 *
 *   /api/gearasset/:hash  ->  proxied .tgxm geometry + texture containers
 *   ->  parse  ->  build BufferGeometry  ->  decode textures  ->  Three.js meshes
 *
 * Texture -> mesh association comes from `region_index_sets` in the gear-asset
 * content: each entry maps geometry indices to the texture-container indices
 * that dress them. Within a container, entry suffixes give the role
 * (diffuse `_0`, normal `_1`, gearstack `_2`). See textureContainer.ts.
 *
 * Returns a THREE.Group plus a debug payload for the POC.
 */
import * as THREE from "three";
import { parseTgxm } from "@/lib/geometry/tgxm";
import { buildGeometryFromContainer } from "@/lib/geometry/buildGeometry";
import { summarize } from "@/lib/geometry/renderMetadata";
import {
  extractTextureImages,
  pickBestByRole,
  type TexImage,
} from "@/lib/geometry/textureContainer";
import { dyeSetFromGearDyes, type DyeSet } from "@/lib/materials/gearDye";
import {
  createGearMaterials,
  type GearTextureMaps,
} from "@/lib/materials/gearMaterial";

export interface GearModelDebug {
  itemHash: number;
  manifestVersion?: string;
  geometryFiles: string[];
  textureFiles: string[];
  gearFiles: string[];
  meshCount: number;
  texturedMeshCount: number;
  totalTriangles: number;
  metadataSummaries: unknown[];
  warnings: string[];
}

export interface LoadedGearModel {
  group: THREE.Group;
  debug: GearModelDebug;
}

interface FileRef {
  file: string;
  cdnPath: string;
  proxyUrl: string;
}

interface RegionEntry {
  textures?: number[];
  geometry?: number[];
}

interface GearAssetResponse {
  itemHash: number;
  found: boolean;
  manifestVersion?: string;
  content: {
    platform: string | null;
    geometry: FileRef[];
    textures: FileRef[];
    gear: FileRef[];
    region_index_sets: Record<string, RegionEntry[]> | null;
    dye_index_set: RegionEntry | null;
  }[];
}

/** geometryIndex -> texture-container indices, from region_index_sets. */
function buildGeomTextureMap(
  regions: Record<string, RegionEntry[]> | null,
): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (!regions) return map;
  for (const entries of Object.values(regions)) {
    for (const entry of entries) {
      for (const gi of entry.geometry ?? []) {
        const cur = map.get(gi) ?? [];
        map.set(gi, cur.concat(entry.textures ?? []));
      }
    }
  }
  return map;
}

async function bytesToTexture(
  bytes: Uint8Array,
  srgb: boolean,
): Promise<THREE.Texture> {
  // Copy into a fresh ArrayBuffer (bytes is a subarray view of the container).
  const blob = new Blob([bytes.slice()]);
  const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // UVs are already V-flipped in buildGeometry
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export interface LoadOptions {
  /** Apply this shader's dye colours to the model. */
  shaderHash?: number | null;
}

export async function loadGearModel(
  itemHash: number,
  opts: LoadOptions = {},
): Promise<LoadedGearModel> {
  const warnings: string[] = [];

  const res = await fetch(`/api/gearasset/${itemHash}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `gearasset lookup failed (${res.status})`);
  }
  const data = (await res.json()) as GearAssetResponse;

  if (!data.found || data.content.length === 0) {
    throw new Error("No gear-asset content for this item hash.");
  }

  const content =
    data.content.find((c) => c.geometry.length > 0) ?? data.content[0];

  // A shader supplies per-slot dye colours; without one the item shows its baked
  // textures (weapons look right; armor is neutral until a shader is applied).
  let dyeSet: DyeSet = {};
  let applyDye = false;
  if (opts.shaderHash) {
    try {
      const dyeRes = await fetch(`/api/dyes/${opts.shaderHash}`).then((r) => r.json());
      if (dyeRes.slots && Object.keys(dyeRes.slots).length > 0) {
        dyeSet = dyeSetFromGearDyes(dyeRes.slots);
        applyDye = true;
      }
    } catch (err) {
      warnings.push(
        `Shader ${opts.shaderHash} dyes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const geomTexMap = buildGeomTextureMap(content.region_index_sets);
  // Cache parsed texture containers by index (a container can dress >1 mesh).
  const texContainerCache = new Map<number, TexImage[]>();

  async function texturesForGeometry(gi: number): Promise<GearTextureMaps> {
    const texIdxs = geomTexMap.get(gi) ?? [];
    const images: TexImage[] = [];
    for (const ti of texIdxs) {
      const ref = content.textures[ti];
      if (!ref) continue;
      try {
        let entries = texContainerCache.get(ti);
        if (!entries) {
          const buf = await fetch(ref.proxyUrl).then((r) => {
            if (!r.ok) throw new Error(`texture ${r.status}`);
            return r.arrayBuffer();
          });
          entries = extractTextureImages(buf);
          texContainerCache.set(ti, entries);
        }
        images.push(...entries);
      } catch (err) {
        warnings.push(
          `Texture #${ti} (${ref.file}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const maps: GearTextureMaps = {};
    const diffuse = pickBestByRole(images, "diffuse");
    const normal = pickBestByRole(images, "normal");
    const gearstack = pickBestByRole(images, "gearstack");
    if (diffuse) maps.diffuse = await bytesToTexture(diffuse.bytes, true);
    if (normal) maps.normal = await bytesToTexture(normal.bytes, false);
    if (gearstack) maps.gearstack = await bytesToTexture(gearstack.bytes, false);
    return maps;
  }

  const group = new THREE.Group();
  group.name = `item_${itemHash}`;
  const metadataSummaries: unknown[] = [];
  let meshCount = 0;
  let texturedMeshCount = 0;
  let totalTriangles = 0;

  for (let gi = 0; gi < content.geometry.length; gi++) {
    const geom = content.geometry[gi];
    try {
      const buf = await fetch(geom.proxyUrl).then((r) => {
        if (!r.ok) throw new Error(`asset ${r.status}`);
        return r.arrayBuffer();
      });
      const container = parseTgxm(buf);
      const built = buildGeometryFromContainer(container);
      metadataSummaries.push({ file: geom.file, ...summarize(built.metadata) });

      const maps = await texturesForGeometry(gi);
      const hasTex = !!(maps.diffuse || maps.normal || maps.gearstack);

      for (const m of built.meshes) {
        // Gearstack drives AO + roughness; dye tinting turns on only when a
        // shader supplied colours (applyDye), blended by the gearstack mask.
        const materials = createGearMaterials(m.groupDyeIndices, dyeSet, maps, {
          useGearstack: true,
          applyDye,
        });
        const mesh = new THREE.Mesh(m.geometry, materials);
        mesh.name = geom.file;
        group.add(mesh);
        meshCount++;
        if (hasTex) texturedMeshCount++;
        const idx = m.geometry.getIndex();
        if (idx) totalTriangles += idx.count / 3;
      }
    } catch (err) {
      warnings.push(
        `Geometry "${geom.file}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (meshCount === 0) {
    throw new Error(
      `Parsed gear asset but built 0 meshes. ${warnings.join(" | ")}`,
    );
  }

  // Center + normalize scale so the viewer frames it regardless of unit scale.
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  group.position.sub(center);
  const scale = 2 / maxDim;
  const wrapper = new THREE.Group();
  wrapper.add(group);
  wrapper.scale.setScalar(scale);

  return {
    group: wrapper,
    debug: {
      itemHash,
      manifestVersion: data.manifestVersion,
      geometryFiles: content.geometry.map((g) => g.file),
      textureFiles: content.textures.map((t) => t.file),
      gearFiles: content.gear.map((g) => g.file),
      meshCount,
      texturedMeshCount,
      totalTriangles: Math.round(totalTriangles),
      metadataSummaries,
      warnings,
    },
  };
}

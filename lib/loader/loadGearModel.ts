/**
 * Browser-side gear model loader. Runs the full pipeline for one item hash:
 *
 *   /api/gearasset/:hash  ->  proxied .tgxm geometry containers  ->  parse
 *   ->  build BufferGeometry  ->  resolve dyes  ->  Three.js meshes
 *
 * Returns a THREE.Group plus a debug payload so the POC can show exactly what
 * resolved (geometry files, texture files, metadata summary). Texture loading
 * is intentionally best-effort/off by default — geometry visibility is the POC
 * gate; textures + gearstack are tuned once we see live data.
 */
import * as THREE from "three";
import { parseTgxm } from "@/lib/geometry/tgxm";
import { buildGeometryFromContainer } from "@/lib/geometry/buildGeometry";
import { summarize } from "@/lib/geometry/renderMetadata";
import { resolveDyeSet } from "@/lib/materials/gearDye";
import { createGearMaterials } from "@/lib/materials/gearMaterial";

export interface GearModelDebug {
  itemHash: number;
  manifestVersion?: string;
  geometryFiles: string[];
  textureFiles: string[];
  gearFiles: string[];
  meshCount: number;
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

interface GearAssetResponse {
  itemHash: number;
  found: boolean;
  manifestVersion?: string;
  content: {
    platform: string | null;
    geometry: FileRef[];
    textures: FileRef[];
    gear: FileRef[];
  }[];
  raw?: {
    content?: {
      default_dyes?: unknown[];
      locked_dyes?: unknown[];
      custom_dyes?: unknown[];
    }[];
  };
}

export async function loadGearModel(itemHash: number): Promise<LoadedGearModel> {
  const warnings: string[] = [];

  const res = await fetch(`/api/gearasset/${itemHash}?raw=1`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `gearasset lookup failed (${res.status})`);
  }
  const data = (await res.json()) as GearAssetResponse;

  if (!data.found || data.content.length === 0) {
    throw new Error("No gear-asset content for this item hash.");
  }

  // Prefer a content record that actually has geometry.
  const content =
    data.content.find((c) => c.geometry.length > 0) ?? data.content[0];

  const rawContent = data.raw?.content?.[0] ?? {};
  const dyeSet = resolveDyeSet({
    locked: rawContent.locked_dyes,
    custom: rawContent.custom_dyes,
    default: rawContent.default_dyes,
  });

  const group = new THREE.Group();
  group.name = `item_${itemHash}`;
  const metadataSummaries: unknown[] = [];
  let meshCount = 0;
  let totalTriangles = 0;

  for (const geom of content.geometry) {
    try {
      const buf = await fetch(geom.proxyUrl).then((r) => {
        if (!r.ok) throw new Error(`asset ${r.status}`);
        return r.arrayBuffer();
      });
      const container = parseTgxm(buf);
      const built = buildGeometryFromContainer(container);
      metadataSummaries.push({ file: geom.file, ...summarize(built.metadata) });

      for (const m of built.meshes) {
        const materials = createGearMaterials(m.groupDyeIndices, dyeSet);
        const mesh = new THREE.Mesh(m.geometry, materials);
        mesh.name = geom.file;
        group.add(mesh);
        meshCount++;
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
      totalTriangles: Math.round(totalTriangles),
      metadataSummaries,
      warnings,
    },
  };
}

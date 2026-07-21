/**
 * Browser-side gear model loader. Runs the full pipeline for one item hash:
 *
 *   /api/gearasset/:hash  ->  proxied .tgxm geometry + texture containers
 *   ->  parse  ->  build BufferGeometry  ->  decode textures  ->  Three.js meshes
 *
 * Texturing has two paths, in priority order:
 *  1. Texture PLATES (render_metadata.texture_plates): the mesh UVs address a
 *     fixed-size atlas assembled from small sub-textures at exact positions —
 *     we composite it with OffscreenCanvas. Most armor works this way; using a
 *     raw sub-texture instead produces smeared/misplaced texturing.
 *  2. Direct textures: role-suffixed entries (`_0` diffuse / `_1` normal /
 *     `_2` gearstack) mapped per geometry via `region_index_sets` (weapons), or
 *     pooled from all containers when no region map exists.
 *
 * Returns a THREE.Group plus a debug payload for the POC.
 */
import * as THREE from "three";
import { parseTgxm } from "@/lib/geometry/tgxm";
import { buildGeometryFromContainer } from "@/lib/geometry/buildGeometry";
import { summarize, type TexturePlate, type TexturePlateSet } from "@/lib/geometry/renderMetadata";
import {
  extractTextureImages,
  pickBestByRole,
  type TexImage,
} from "@/lib/geometry/textureContainer";
import { dyeSetFromGearDyes, resolveDyeSet, type DyeSet } from "@/lib/materials/gearDye";
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
  /** Which geometry indices to render (null = all); excludes body/gender overrides. */
  renderGeometryIndices: number[] | null;
}

interface FetchedDyes {
  default: DyeSet;
  /** locked_dyes — always render regardless of an applied shader (exotics). */
  locked: DyeSet;
}

async function fetchDyeSet(hash: number): Promise<FetchedDyes> {
  try {
    const res = await fetch(`/api/dyes/${hash}`).then((r) => r.json());
    return {
      default: res.slots ? dyeSetFromGearDyes(res.slots) : {},
      locked: res.locked ? dyeSetFromGearDyes(res.locked) : {},
    };
  } catch {
    /* ignore — model still renders with baked textures */
  }
  return { default: {}, locked: {} };
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

/**
 * Flag geometry groups whose UVs sit (mostly) inside a self-illuminated glow
 * region (e.g. `exotic_hawkeye_glow`). Those render additively so the black
 * around the glow is transparent instead of an opaque black socket.
 */
function markGlowGroups(
  geometry: THREE.BufferGeometry,
  groups: import("@/lib/geometry/buildGeometry").GroupInfo[],
  plate: TexturePlate | undefined,
): void {
  if (!plate) return;
  const uv = geometry.getAttribute("uv");
  const idx = geometry.getIndex();
  if (!uv || !idx) return;
  const [pw, ph] = plate.size;
  const glowRects = plate.placements
    .filter((p) => /glow|hawkeye/i.test(p.name))
    .map((p) => ({ x: p.x / pw, y: p.y / ph, w: p.w / pw, h: p.h / ph }));
  if (glowRects.length === 0) return;

  for (const gr of geometry.groups) {
    let inGlow = 0;
    let total = 0;
    for (let i = gr.start; i < gr.start + gr.count; i += 3) {
      const vi = idx.getX(i);
      const u = uv.getX(vi);
      const v = uv.getY(vi);
      total++;
      if (glowRects.some((r) => u >= r.x && u < r.x + r.w && v >= r.y && v < r.y + r.h)) {
        inGlow++;
      }
    }
    const g = groups[gr.materialIndex ?? -1];
    if (g && total > 0 && inGlow / total > 0.7) g.glow = true;
  }
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
  tex.anisotropy = 16; // max out filtering — mobile plates are only 512px
  tex.needsUpdate = true;
  return tex;
}

export interface LoadOptions {
  /** Apply this shader's dye colours to the model. */
  shaderHash?: number | null;
  /**
   * Center + normalize the model to a unit box for a standalone viewer
   * (default). Pass `false` for character assembly: the raw group is returned
   * in Destiny's native bind-pose space so multiple pieces align on one body.
   */
  frame?: boolean;
  /**
   * Skip geometry index 0. On every cloak we've inspected, the hood ships as
   * its own rigid (unskinned) geometry file separate from the skinned cape
   * body, always at index 0 — confirmed on Memory of Cayde Cloak (625602056):
   * excluding index 0 renders the cape with no hood, index 0 alone IS the
   * hood. Bungie exposes no data flag for which helmets should trigger this
   * (see lib/bungie/hoodHiding.ts) — the toggle itself is the data-driven part.
   */
  hideHood?: boolean;
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

  // Dye colours + emissive: the item's own gear file gives its default look
  // (armor colour, glow); a shader, if applied, overrides those colours — EXCEPT
  // slots the item's own gear file marks as locked_dyes, which always win
  // regardless of the applied shader (Bungie's documented resolution order:
  // defaultDyes -> customDyes -> lockedDyes, locked last = highest priority).
  const itemDyes = await fetchDyeSet(itemHash);
  const shaderDyes = opts.shaderHash ? await fetchDyeSet(opts.shaderHash) : null;
  const dyeSet: DyeSet = resolveDyeSet(
    itemDyes.default,
    shaderDyes?.default ?? {},
    itemDyes.locked,
  );
  const applyDye = Object.keys(dyeSet).length > 0;

  // Which geometry to render (skip gender/class body overrides that overlap).
  const renderSet = data.renderGeometryIndices
    ? new Set(data.renderGeometryIndices)
    : null;

  const geomTexMap = buildGeomTextureMap(content.region_index_sets);
  const allTextureIndices = content.textures.map((_, i) => i);
  // Cache parsed texture containers by index (a container can dress >1 mesh).
  const texContainerCache = new Map<number, TexImage[]>();

  async function loadContainer(ti: number): Promise<TexImage[]> {
    const cached = texContainerCache.get(ti);
    if (cached) return cached;
    const ref = content.textures[ti];
    if (!ref) return [];
    try {
      const buf = await fetch(ref.proxyUrl).then((r) => {
        if (!r.ok) throw new Error(`texture ${r.status}`);
        return r.arrayBuffer();
      });
      const entries = extractTextureImages(buf);
      texContainerCache.set(ti, entries);
      return entries;
    } catch (err) {
      warnings.push(
        `Texture #${ti} (${ref.file}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      texContainerCache.set(ti, []);
      return [];
    }
  }

  async function imagesFor(texIdxs: number[]): Promise<TexImage[]> {
    const out: TexImage[] = [];
    for (const ti of texIdxs) out.push(...(await loadContainer(ti)));
    return out;
  }

  // Every entry across all containers, keyed by entry name — plate placements
  // reference entries by exact name.
  let entriesByNameMemo: Map<string, TexImage> | null = null;
  async function entriesByName(): Promise<Map<string, TexImage>> {
    if (entriesByNameMemo) return entriesByNameMemo;
    const map = new Map<string, TexImage>();
    for (const img of await imagesFor(allTextureIndices)) {
      if (!map.has(img.name)) map.set(img.name, img);
    }
    entriesByNameMemo = map;
    return map;
  }

  /**
   * Composite one plate atlas from its placements. `nearest` disables all
   * interpolation — required for ID-mask plates (dyeslot) where blending
   * neighbouring values corrupts the encoded slot indices.
   */
  async function assemblePlate(
    plate: TexturePlate,
    srgb: boolean,
    nearest = false,
    cleanChroma = false,
  ): Promise<THREE.Texture | null> {
    const lookup = await entriesByName();
    const canvas = new OffscreenCanvas(plate.size[0], plate.size[1]);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = !nearest;
    // A single low-res placement at the origin is a downsampled whole-plate map
    // (e.g. a 64px dyeslot mask in a "256" plate) — stretch it to cover the full
    // UV space instead of leaving 15/16ths of the plate empty. ONLY for the
    // nearest-filtered ID-mask plates: colour plates (diffuse/normal/gearstack)
    // legitimately place a single sub-texture in a sub-REGION of the plate
    // (cloaks like Relativism), and stretching those shifts/scales all
    // texturing off its UVs.
    const stretchAll =
      nearest &&
      plate.placements.length === 1 &&
      plate.placements[0].x === 0 &&
      plate.placements[0].y === 0;
    let drawn = 0;
    for (const pl of plate.placements) {
      const entry = lookup.get(pl.name);
      if (!entry) {
        warnings.push(`Plate entry not found: ${pl.name}`);
        continue;
      }
      const bitmap = await createImageBitmap(new Blob([entry.bytes.slice()]), {
        imageOrientation: "none",
      });
      if (stretchAll) ctx.drawImage(bitmap, 0, 0, plate.size[0], plate.size[1]);
      else ctx.drawImage(bitmap, pl.x, pl.y, pl.w, pl.h);
      drawn++;
    }
    if (drawn === 0) return null;

    // Bungie's mobile sub-textures are chroma-subsampled (JPEG-style), leaving
    // green/magenta fringing at high-contrast edges — e.g. Nighthawk's white
    // emblem panel + black hawk against the red trim. Fix it the standard way:
    // convert to YCbCr, BLUR the chroma (Cb/Cr) while keeping luminance (Y)
    // sharp. Real colours (gold, red) are low-frequency and survive; the
    // high-frequency chroma noise is smoothed away, and all luminance detail
    // (the panel, ticks, hawk) stays crisp.
    if (cleanChroma) {
      const w = canvas.width, h = canvas.height;
      const img = ctx.getImageData(0, 0, w, h);
      const p = img.data;
      const N = w * h;
      const Y = new Float32Array(N);
      const Cb = new Float32Array(N);
      const Cr = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const r = p[i * 4], g = p[i * 4 + 1], b = p[i * 4 + 2];
        Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      // Separable box blur (radius 2) of a chroma channel, in place via a temp.
      const tmp = new Float32Array(N);
      const boxBlur = (ch: Float32Array) => {
        const R = 2;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let s = 0, c = 0;
            for (let dx = -R; dx <= R; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              s += ch[y * w + xx]; c++;
            }
            tmp[y * w + x] = s / c;
          }
        }
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let s = 0, c = 0;
            for (let dy = -R; dy <= R; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= h) continue;
              s += tmp[yy * w + x]; c++;
            }
            ch[y * w + x] = s / c;
          }
        }
      };
      boxBlur(Cb);
      boxBlur(Cr);
      for (let i = 0; i < N; i++) {
        const y = Y[i], cb = Cb[i], cr = Cr[i];
        p[i * 4] = y + 1.402 * cr;
        p[i * 4 + 1] = y - 0.344136 * cb - 0.714136 * cr;
        p[i * 4 + 2] = y + 1.772 * cb;
      }
      ctx.putImageData(img, 0, 0);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; // Destiny UVs are v-down, matching image rows directly
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // atlas — don't bleed
    if (nearest) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    } else {
      tex.anisotropy = 16; // max out filtering — mobile plates are only 512px
    }
    tex.needsUpdate = true;
    return tex;
  }

  /** Preferred path: assemble the plate atlases the UVs actually address. */
  async function texturesFromPlates(plates: TexturePlateSet): Promise<GearTextureMaps> {
    const maps: GearTextureMaps = {};
    const diffuse = plates.diffuse ? await assemblePlate(plates.diffuse, true, false, true) : null;
    const normal = plates.normal ? await assemblePlate(plates.normal, false) : null;
    const gearstack = plates.gearstack ? await assemblePlate(plates.gearstack, false) : null;
    const dyeslot = plates.dyeslot
      ? await assemblePlate(plates.dyeslot, false, true)
      : null;
    if (diffuse) maps.diffuse = diffuse;
    if (normal) maps.normal = normal;
    if (gearstack) maps.gearstack = gearstack;
    // A real dyeslot plate (per-pixel slot mask) when present; otherwise slots
    // come from each geometry group's gear_dye_change_color_index.
    if (dyeslot) maps.dyeslot = dyeslot;
    // Dedicated glow containers (e.g. weapons) still apply on top of plates.
    const emissive = pickBestByRole(await imagesFor(allTextureIndices), "emissive");
    if (emissive) maps.emissive = await bytesToTexture(emissive.bytes, true);
    return maps;
  }

  /**
   * Resolve each dye slot's tiled detail maps (named entries inside the item's
   * texture containers) into THREE textures with repeat wrapping.
   */
  async function attachDetailTextures(dyes: DyeSet): Promise<void> {
    const lookup = await entriesByName();
    for (const dye of Object.values(dyes)) {
      const dif = dye.detailDiffuseName ? lookup.get(dye.detailDiffuseName) : null;
      const norm = dye.detailNormalName ? lookup.get(dye.detailNormalName) : null;
      if (dif) {
        dye.detailDiffuse = await bytesToTexture(dif.bytes, true);
        dye.detailDiffuse.wrapS = dye.detailDiffuse.wrapT = THREE.RepeatWrapping;
      }
      if (norm) {
        dye.detailNormal = await bytesToTexture(norm.bytes, false);
        dye.detailNormal.wrapS = dye.detailNormal.wrapT = THREE.RepeatWrapping;
      }
    }
  }

  /** Fallback path: direct role-suffixed textures (region-mapped or pooled). */
  async function texturesForGeometry(gi: number): Promise<GearTextureMaps> {
    const texIdxs = geomTexMap.get(gi) ?? allTextureIndices;
    const images = await imagesFor(texIdxs);

    const maps: GearTextureMaps = {};
    const diffuse = pickBestByRole(images, "diffuse");
    const normal = pickBestByRole(images, "normal");
    const gearstack = pickBestByRole(images, "gearstack");
    const emissive = pickBestByRole(images, "emissive");
    if (diffuse) maps.diffuse = await bytesToTexture(diffuse.bytes, true);
    if (normal) maps.normal = await bytesToTexture(normal.bytes, false);
    if (gearstack) maps.gearstack = await bytesToTexture(gearstack.bytes, false);
    if (emissive) maps.emissive = await bytesToTexture(emissive.bytes, true);
    return maps;
  }

  // Resolve each dye slot's tiled detail maps before building materials.
  try {
    await attachDetailTextures(dyeSet);
  } catch (err) {
    warnings.push(
      `Detail textures failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const group = new THREE.Group();
  group.name = `item_${itemHash}`;
  const metadataSummaries: unknown[] = [];
  let meshCount = 0;
  let texturedMeshCount = 0;
  let totalTriangles = 0;

  for (let gi = 0; gi < content.geometry.length; gi++) {
    if (renderSet && !renderSet.has(gi)) continue; // skip overlapping overrides
    if (opts.hideHood && gi === 0) continue; // skip the hood geometry file
    const geom = content.geometry[gi];
    try {
      const buf = await fetch(geom.proxyUrl).then((r) => {
        if (!r.ok) throw new Error(`asset ${r.status}`);
        return r.arrayBuffer();
      });
      const container = parseTgxm(buf);
      const built = buildGeometryFromContainer(container);
      metadataSummaries.push({ file: geom.file, ...summarize(built.metadata) });
      // Dev aid: expose raw metadata + container file names for skeleton R&D.
      if (typeof window !== "undefined") {
        const w = window as unknown as Record<string, unknown>;
        w.__meta = built.metadata;
        (w.__metaByFile as Record<string, unknown>) =
          (w.__metaByFile as Record<string, unknown>) ?? {};
        (w.__metaByFile as Record<string, unknown>)[geom.file] = built.metadata;
        w.__containerFiles = container.files.map((f) => f.name);
      }

      // Prefer the plate atlases (what the UVs address); fall back to direct
      // textures when the item ships no plates or assembly produced nothing.
      let maps: GearTextureMaps = {};
      if (built.metadata.plates) {
        maps = await texturesFromPlates(built.metadata.plates);
      }
      if (!maps.diffuse) {
        maps = { ...(await texturesForGeometry(gi)), ...maps };
      }
      const hasTex = !!(maps.diffuse || maps.normal || maps.gearstack);

      for (const m of built.meshes) {
        // Flag glow geometry (Nighthawk's eye) so it renders additively.
        markGlowGroups(m.geometry, m.groups, built.metadata.plates?.diffuse);
        // Gearstack drives AO/roughness/emissive; the dyeslot plate (or
        // gearstack alpha) masks dye zones; decal groups render additively.
        const isCloth = Object.values(dyeSet).some((d) => d.cloth);
        const materials = createGearMaterials(m.groups, dyeSet, maps, {
         useGearstack: true,
          applyDye,
          plated: !!built.metadata.plates && !isCloth,
        });
        const mesh = new THREE.Mesh(m.geometry, materials);
        mesh.name = geom.file;
        mesh.userData.maps = maps; // dev aid: inspectable from the console
        mesh.userData.groups = m.groups;
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

  // Character assembly wants the raw group in native bind-pose space so pieces
  // line up on one body; the union is framed later by the character loader.
  if (opts.frame === false) {
    return { group, debug: makeDebug() };
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
  // Destiny geometry is Z-up; stand it upright for the Y-up viewer.
  wrapper.rotation.x = -Math.PI / 2;

  return { group: wrapper, debug: makeDebug() };

  function makeDebug(): GearModelDebug {
    return {
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
    };
  }
}

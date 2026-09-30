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
  matchPatternTextureNames,
  matchAccentTextureNames,
  type GearTextureMaps,
} from "@/lib/materials/gearMaterial";
import { decodeDataPng, placeDataTile, type RgbaImage } from "@/lib/geometry/dataTexture";
import { partitionGlowGroups } from "@/lib/geometry/glowGroups";
import { reconstructMaterialBoundaries } from "@/lib/geometry/materialBoundaries";
import { decodeDyeSlotMap, dyeSlotPlate } from "@/lib/geometry/dyeSlotMap";
import { itemHasAnimatedGlow } from "@/lib/bungie/glowAnimatedItems";
import { transparentEffect } from "@/lib/geometry/transparentEffects";

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
  notes?: string[];
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
  warning?: string;
  default: DyeSet;
  /** locked_dyes — always render regardless of an applied shader (exotics). */
  locked: DyeSet;
}

async function fetchDyeSet(hash: number, targetHash?: number): Promise<FetchedDyes> {
  try {
    const response = await fetch(`/api/dyes/${hash}${targetHash ? `?target=${targetHash}` : ""}`);
    if (!response.ok) throw new Error(`dye lookup failed (${response.status})`);
    const res = await response.json();
    return {
      default: res.slots ? dyeSetFromGearDyes(res.slots) : {},
      locked: res.locked ? dyeSetFromGearDyes(res.locked) : {},
      warning: targetHash && !Object.keys(res.slots ?? {}).length
        ? `Shader ${hash} has no exported dyes matching item ${targetHash}'s material channels.` : undefined,
    };
  } catch (error) {
    return { default: {}, locked: {}, warning: `Dyes for ${hash} unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
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
  if (!srgb && bytes[0] === 137 && bytes[1] === 80) {
    return dataTexture(decodeDataPng(bytes), false, true);
  }
  // Copy into a fresh ArrayBuffer (bytes is a subarray view of the container).
  const blob = new Blob([bytes.slice()]);
  const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // Destiny UVs follow image rows directly.
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16; // max out filtering — mobile plates are only 512px
  tex.needsUpdate = true;
  return tex;
}

function dataTexture(image: RgbaImage, nearest = false, repeat = false): THREE.DataTexture {
  const tex = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = !nearest;
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
  const notes: string[] = [];

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
  const shaderDyes = opts.shaderHash ? await fetchDyeSet(opts.shaderHash, itemHash) : null;
  if (itemDyes.warning) warnings.push(itemDyes.warning);
  if (shaderDyes?.warning) warnings.push(shaderDyes.warning);
  const dyeSet: DyeSet = resolveDyeSet(
    itemDyes.default,
    shaderDyes?.default ?? {},
    itemDyes.locked,
  );
  const applyDye = Object.keys(dyeSet).length > 0;
  let iridescenceLookup: THREE.Texture | undefined;
  if (Object.values(dyeSet).some((d) => d.primary.materialTypeId >= 0 || d.secondary.materialTypeId >= 0)) {
    try {
      const response = await fetch("/textures/iridescence-lookup.png");
      if (!response.ok) throw new Error(`lookup ${response.status}`);
      iridescenceLookup = dataTexture(decodeDataPng(new Uint8Array(await response.arrayBuffer())), false);
      iridescenceLookup.colorSpace = THREE.SRGBColorSpace;
      iridescenceLookup.generateMipmaps = false;
      iridescenceLookup.minFilter = THREE.LinearFilter;
      iridescenceLookup.magFilter = THREE.LinearFilter;
    } catch (error) {
      warnings.push(`Iridescence texture failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
    // Applied dyes reference the SHADER's texture containers. Looking only in
    // the armor's containers silently lost weave/grain/normal detail on swaps.
    const needed = new Set(Object.values(dyeSet).flatMap((d) =>
      [d.detailDiffuseName, d.detailNormalName].filter((n): n is string => !!n),
    ));
    if (opts.shaderHash && [...needed].some((name) => !map.has(name))) {
      try {
        const response = await fetch(`/api/gearasset/${opts.shaderHash}`);
        if (!response.ok) throw new Error(`shader asset ${response.status}`);
        const shaderAsset = await response.json() as GearAssetResponse;
        const files = new Map(shaderAsset.content.flatMap((c) => c.textures)
          .map((file) => [file.proxyUrl, file]));
        for (const file of files.values()) {
          if ([...needed].every((name) => map.has(name))) break;
          const response = await fetch(file.proxyUrl);
          if (!response.ok) throw new Error(`shader texture ${response.status}`);
          for (const image of extractTextureImages(await response.arrayBuffer())) {
            if (needed.has(image.name) && !map.has(image.name)) map.set(image.name, image);
          }
        }
      } catch (error) {
        warnings.push(`Shader detail textures: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    if (!srgb) {
      const [width, height] = plate.size;
      const atlas: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
      let placed = 0;
      for (const pl of plate.placements) {
        const entry = lookup.get(pl.name);
        if (!entry) { warnings.push(`Plate entry not found: ${pl.name}`); continue; }
        try {
          placeDataTile(atlas, decodeDataPng(entry.bytes), pl.x, pl.y, pl.w, pl.h);
          placed++;
        } catch (error) {
          warnings.push(`Material data ${pl.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return placed ? dataTexture(atlas, nearest) : null;
    }
    const canvas = new OffscreenCanvas(plate.size[0], plate.size[1]);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = !nearest;
    // Each tile keeps its authored position and extent within its role's atlas.
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
      ctx.drawImage(bitmap, pl.x, pl.y, pl.w, pl.h);
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
    let dyeslot: THREE.Texture | null = null;
    if (plates.dyeslot) {
      try {
        const raw = await assemblePlate(dyeSlotPlate(plates.dyeslot), false, true);
        if (raw) {
          const decoded = decodeDyeSlotMap(raw.image as RgbaImage);
          dyeslot = dataTexture(decoded, true);
          dyeslot.userData.encoding = "change-color-index-plus-one";
          const overrideTexelsById = [0, 0, 0, 0, 0, 0];
          for (let p = 0; p < decoded.data.length; p += 4) {
            const id = decoded.data[p] - 1;
            if (id >= 0) overrideTexelsById[id]++;
          }
          dyeslot.userData.dyeMap = { width: decoded.width, height: decoded.height, overrideTexelsById };
          raw.dispose();
        }
      } catch (error) {
        warnings.push(`Dye map unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (diffuse) maps.diffuse = diffuse;
    if (normal) maps.normal = normal;
    if (gearstack) maps.gearstack = gearstack;
    if (plates.gearstack && plates.diffuse && gearstack) {
      maps.materialBoundaries = await materialBoundaryPlate(plates);
    }
    // Authored per-pixel IDs override geometry IDs where the map is active.
    if (dyeslot) maps.dyeslot = dyeslot;
    // Only plate metadata establishes atlas bindings. Shared VFX resources
    // containing "illum"/"glow" are NOT extra whole-surface emission maps.
    return maps;
  }

  async function materialBoundaryPlate(plates: TexturePlateSet): Promise<THREE.Texture | undefined> {
    const gs = plates.gearstack!, dif = plates.diffuse!;
    if (dif.size[0] < gs.size[0] || dif.size[1] < gs.size[1] ||
        dif.size[0] * dif.size[1] > 4_194_304) return;
    const lookup = await entriesByName();
    const atlas: RgbaImage = { width: dif.size[0], height: dif.size[1], data: new Uint8Array(dif.size[0] * dif.size[1] * 4) };
    let estimatedTexels = 0, refinedTiles = 0;
    // Match normalized atlas rectangles, not names or material-name guesses.
    const matching = (plate: TexturePlate | undefined, tile: TexturePlate["placements"][number]) =>
      plate?.placements.find((p) =>
        Math.abs(p.x / plate.size[0] - tile.x / gs.size[0]) < 1e-6 &&
        Math.abs(p.y / plate.size[1] - tile.y / gs.size[1]) < 1e-6 &&
        Math.abs(p.w / plate.size[0] - tile.w / gs.size[0]) < 1e-6 &&
        Math.abs(p.h / plate.size[1] - tile.h / gs.size[1]) < 1e-6);
    for (const tile of gs.placements) {
      const entry = lookup.get(tile.name);
      // A partial reconstruction must not replace the complete original map.
      if (!entry) return;
      try {
        const source = decodeDataPng(entry.bytes);
        const colorTile = matching(dif, tile), normalTile = matching(plates.normal, tile);
        const colorEntry = colorTile && lookup.get(colorTile.name);
        const normalEntry = normalTile && lookup.get(normalTile.name);
        let color: RgbaImage | undefined;
        if (colorEntry) {
          const bitmap = await createImageBitmap(new Blob([colorEntry.bytes.slice()]), { imageOrientation: "none" });
          try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(bitmap, 0, 0);
              const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
              color = { width: bitmap.width, height: bitmap.height, data: new Uint8Array(pixels.data.buffer) };
            }
          } finally { bitmap.close(); }
        }
        const result = reconstructMaterialBoundaries(source, color, normalEntry ? decodeDataPng(normalEntry.bytes) : undefined);
        if (result.image !== source) refinedTiles++;
        estimatedTexels += result.estimatedTexels;
        placeDataTile(atlas, result.image,
          Math.round(tile.x * atlas.width / gs.size[0]), Math.round(tile.y * atlas.height / gs.size[1]),
          Math.round(tile.w * atlas.width / gs.size[0]), Math.round(tile.h * atlas.height / gs.size[1]));
      } catch (error) {
        warnings.push(`Material boundary refinement unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (!refinedTiles) return;
    const tex = dataTexture(atlas, true);
    tex.userData.materialBoundaries = { method: "alpha-color-smoothness-normal", estimatedTexels, refinedTiles };
    return tex;
  }

  // Pattern-shimmer warp textures (see gearMaterial.ts isPatternGroup), keyed
  // by exact entry name rather than per-geometry-file: Relativism's own data
  // shows the same noise+ripple names recur across separate geometry files
  // (shell + cloth), so name-keyed caching avoids decoding the same bitmap
  // twice and creating duplicate GPU textures.
  const patternTextureCache = new Map<string, Promise<THREE.Texture>>();
  async function resolvePatternTexture(name: string): Promise<THREE.Texture | null> {
    const cached = patternTextureCache.get(name);
    if (cached) return cached;
    const lookup = await entriesByName();
    const entry = lookup.get(name);
    if (!entry) return null;
    const promise = bytesToTexture(entry.bytes, false).then((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      return tex;
    });
    patternTextureCache.set(name, promise);
    return promise;
  }

  /**
   * Resolve the pattern-shimmer noise+ripple pair (see isPatternGroup) into
   * `maps.patternNoise`/`patternRipple`, if this geometry file's stage parts
   * reference them. Modeled on attachDetailTextures below — same by-name
   * lookup mechanism, just item-wide instead of per-dye-slot.
   */
  async function attachPatternTextures(
    maps: GearTextureMaps,
    patternNames: string[],
  ): Promise<void> {
    const { noise, ripple } = matchPatternTextureNames(patternNames);
    if (!noise || !ripple) return;
    const [noiseTex, rippleTex] = await Promise.all([
      resolvePatternTexture(noise),
      resolvePatternTexture(ripple),
    ]);
    if (noiseTex) maps.patternNoise = noiseTex;
    if (rippleTex) maps.patternRipple = rippleTex;
  }

  /**
   * Resolve the swirling-darkness accent trio (see isAccentGroup) into
   * `maps.accentTwirl`/`accentBlob`/`accentDarkness`, if this geometry file's
   * stage parts reference the full set. Same by-name lookup + name-keyed cache
   * as the shimmer pair above.
   */
  async function attachAccentTextures(
    maps: GearTextureMaps,
    accentNames: string[],
  ): Promise<void> {
    const { twirl, blob, darkness } = matchAccentTextureNames(accentNames);
    if (!twirl || !blob || !darkness) return;
    const [twirlTex, blobTex, darknessTex] = await Promise.all([
      resolvePatternTexture(twirl),
      resolvePatternTexture(blob),
      resolvePatternTexture(darkness),
    ]);
    if (twirlTex) maps.accentTwirl = twirlTex;
    if (blobTex) maps.accentBlob = blobTex;
    if (darknessTex) maps.accentDarkness = darknessTex;
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
      for (const name of [dye.detailDiffuseName, dye.detailNormalName]) {
        if (name && !lookup.has(name) && !warnings.includes(`Missing detail texture: ${name}`)) {
          warnings.push(`Missing detail texture: ${name}`);
        }
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
    if (diffuse) maps.diffuse = await bytesToTexture(diffuse.bytes, true);
    if (normal) maps.normal = await bytesToTexture(normal.bytes, false);
    if (gearstack) maps.gearstack = await bytesToTexture(gearstack.bytes, false);
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
      if (iridescenceLookup) maps.iridescenceLookup = iridescenceLookup;
      metadataSummaries.push({ file: geom.file, ...summarize(built.metadata),
        dyeMap: maps.dyeslot?.userData.dyeMap ?? null,
        resolvedMaterials: built.meshes.map((m) => m.groups.map((g, i) => ({
          dyeIndex: g.dyeIndex, source: g.dyeSource, triangles: m.geometry.groups[i].count / 3,
        }))),
        materialBoundaries: maps.materialBoundaries?.userData.materialBoundaries ?? null });
      const hasTex = !!(maps.diffuse || maps.normal || maps.gearstack);

      // Pattern-shimmer textures (see isPatternGroup) — resolved once for
      // every mesh built from this geometry file, same as diffuse/normal/
      // gearstack above, since they're item-wide, not per-mesh.
      const patternNames = built.meshes.flatMap((m) =>
        m.groups.flatMap((g) => g.patternTextures ?? []),
      );
      if (patternNames.length > 0) {
        try {
          await attachPatternTextures(maps, patternNames);
          await attachAccentTextures(maps, patternNames);
        } catch (err) {
          warnings.push(
            `Pattern textures failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      for (const m of built.meshes) {
        for (const g of m.groups) {
          const effect = transparentEffect(g);
          if (!effect) continue;
          maps.effectTextures ??= new Map();
          for (const name of effect.textures) {
            if (!name || maps.effectTextures.has(name)) continue;
            try {
              const tex = await resolvePatternTexture(name);
              if (tex) maps.effectTextures.set(name, tex);
              else warnings.push(`Missing glow texture: ${name}`);
            } catch (error) {
              warnings.push(`Glow texture unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        // Flag glow geometry (Nighthawk's eye) so it renders additively.
        partitionGlowGroups(m.geometry, m.groups, built.metadata.plates?.diffuse);
        // Groups include packed vertex material IDs within each authored pass.
        const materials = createGearMaterials(m.groups, dyeSet, maps, {
          useGearstack: true,
          applyDye,
          plated: !!built.metadata.plates,
          singlePart: content.geometry.length <= 1,
          animatedGlow: itemHasAnimatedGlow(itemHash),
          sourceGeometry: m.geometry,
        });
        if (materials.some((material) => material.userData.destiny?.approximateEffect)) {
          const note = "Effect shapes use the exported textures. Motion and brightness are preview approximations.";
          if (!notes.includes(note)) notes.push(note);
        }
        if (materials.some((material) => material.userData.destiny?.emissionFallback)) {
          const note = "Hologram color is estimated from a game reference because the export omits its glow color.";
          if (!notes.includes(note)) notes.push(note);
        }
        if (materials.some((material) => material.userData.destiny?.unsupportedEffect)) {
          const warning = "An unsupported transparent effect is hidden because its material cannot yet be reconstructed.";
          if (!warnings.includes(warning)) warnings.push(warning);
        }
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
      notes,
    };
  }
}

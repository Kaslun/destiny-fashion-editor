/**
 * Destiny manifest resolution.
 *
 * We only need a slice of the manifest for the gear-asset renderer:
 *   - `mobileGearAssetDataBases` — versioned SQLite files holding, per item
 *     hash, the geometry/texture/dye file references (see gearAsset.ts).
 *   - `mobileGearCDN` — base URL paths for Geometry / Texture / Gear / Shader
 *     content on bungie.net's CDN.
 *
 * The manifest is large and versioned; we cache the trimmed result to disk and
 * only re-fetch when Bungie reports a new `version`.
 */
import { promises as fs } from "fs";
import path from "path";
import { bungieFetch } from "./client";

export interface GearAssetDatabase {
  version: number;
  path: string; // e.g. /common/destiny2_content/sqlite/asset/asset_sql_content_<hash>.content
}

export interface MobileGearCDN {
  Geometry: string;
  Texture: string;
  PlateRegion: string;
  Gear: string;
  Shader: string;
}

interface DestinyManifestResponse {
  version: string;
  mobileGearAssetDataBases: GearAssetDatabase[];
  mobileGearCDN: MobileGearCDN;
  jsonWorldContentPaths: Record<string, string>;
  jsonWorldComponentContentPaths: Record<string, Record<string, string>>;
}

export interface ResolvedManifest {
  version: string;
  gearAssetDatabases: GearAssetDatabase[];
  gearCdn: MobileGearCDN;
  /** en-locale aggregate world content path. */
  worldContentPath: string;
  /** en-locale per-table JSON paths (DestinyInventoryItemDefinition, etc.). */
  componentPaths: Record<string, string>;
  fetchedAt: string;
}

const CACHE_DIR = path.join(process.cwd(), "data", "cache");
const MANIFEST_CACHE = path.join(CACHE_DIR, "manifest.json");

let memo: ResolvedManifest | null = null;

async function readCache(): Promise<ResolvedManifest | null> {
  try {
    const raw = await fs.readFile(MANIFEST_CACHE, "utf8");
    return JSON.parse(raw) as ResolvedManifest;
  } catch {
    return null;
  }
}

async function writeCache(m: ResolvedManifest): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(MANIFEST_CACHE, JSON.stringify(m, null, 2), "utf8");
}

/**
 * Resolve the (trimmed) manifest, using the disk cache unless Bungie has
 * published a newer version. Pass `force` to bypass the cache entirely.
 */
export async function getManifest(force = false): Promise<ResolvedManifest> {
  if (memo && !force) return memo;

  const cached = force ? null : await readCache();
  const remote = await bungieFetch<DestinyManifestResponse>(
    "/Destiny2/Manifest/",
  );

  if (cached && cached.version === remote.version && !force) {
    memo = cached;
    return cached;
  }

  const resolved: ResolvedManifest = {
    version: remote.version,
    gearAssetDatabases: remote.mobileGearAssetDataBases ?? [],
    gearCdn: remote.mobileGearCDN,
    worldContentPath: remote.jsonWorldContentPaths?.en ?? "",
    componentPaths: remote.jsonWorldComponentContentPaths?.en ?? {},
    fetchedAt: new Date().toISOString(),
  };

  await writeCache(resolved);
  memo = resolved;
  return resolved;
}

/**
 * Build an absolute bungie.net CDN URL for a gear-asset file.
 * `base` is one of the `mobileGearCDN` entries; `filename` comes from the
 * item's gear-asset content record.
 */
export function cdnUrl(base: string, filename: string): string {
  const cleanBase = base.replace(/\/$/, "");
  const cleanFile = filename.replace(/^\//, "");
  return `${cleanBase}/${cleanFile}`;
}

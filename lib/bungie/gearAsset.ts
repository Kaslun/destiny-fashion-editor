/**
 * Gear-asset resolution.
 *
 * `mobileGearAssetDataBases` entries are SQLite files (not JSON). Each holds a
 * table `DestinyGearAssetsDefinition(id INTEGER, json TEXT)` keyed by item hash.
 * Bungie stores the (unsigned 32-bit) item hash as a *signed* int32 in `id`, so
 * we convert before querying.
 *
 * The parsed `json` describes, per item, the platform-specific content:
 * geometry (.tgxm), textures (.tgxm.bin), gear arrangement files, and the dye /
 * region index sets used to pick which mesh regions and dyes apply.
 *
 * We keep the returned shape loose (`content: unknown[]`) on purpose — the D2
 * mobile gear format has fields Bungie never fully documented, so the POC dumps
 * the raw record and we finalise the typed reader empirically against it.
 */
import initSqlJs, { type Database } from "sql.js";
import { unzipSync } from "fflate";
import { promises as fs } from "fs";
import path from "path";
import { bungieFetchRaw } from "./client";
import { getManifest, type GearAssetDatabase } from "./manifest";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "gearassets");

export interface GearAssetContent {
  platform?: string;
  geometry?: string[];
  textures?: string[];
  plates?: string[];
  gear?: string[];
  dye_index_set?: unknown;
  region_index_sets?: unknown;
  [key: string]: unknown;
}

export interface GearAssetDefinition {
  /** The raw parsed record straight from the SQLite `json` column. */
  raw: {
    gearAsset?: unknown;
    content?: GearAssetContent[];
    [key: string]: unknown;
  };
  /** Convenience: the content records (usually one for D2 mobile). */
  content: GearAssetContent[];
}

/** Convert an unsigned 32-bit item hash to the signed int32 used as the DB key. */
export function hashToSignedId(hash: number): number {
  return hash > 0x7fffffff ? hash - 0x100000000 : hash;
}

// --- sql.js singleton --------------------------------------------------------
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      // In the Node/Next server runtime, load the wasm from node_modules.
      locateFile: (file) =>
        path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
    });
  }
  return sqlPromise;
}

// --- DB file caching ---------------------------------------------------------
function cacheFileFor(db: GearAssetDatabase): string {
  const name = db.path.split("/").pop() ?? `gearassets_${db.version}.content`;
  return path.join(CACHE_DIR, `${db.version}_${name}`);
}

/**
 * Bungie serves the `.content` gear-asset DBs as ZIP archives wrapping the
 * actual SQLite file (magic "PK\x03\x04"). Decompress if needed.
 */
function unwrapDatabase(bytes: Uint8Array): Uint8Array {
  const isZip =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) return bytes;
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);
  if (names.length === 0) throw new Error("Gear asset ZIP is empty");
  // The archive holds a single SQLite file named like the .content itself.
  return entries[names[0]];
}

async function ensureDbFile(db: GearAssetDatabase): Promise<Uint8Array> {
  const target = cacheFileFor(db); // cached already-decompressed
  try {
    const buf = await fs.readFile(target);
    return new Uint8Array(buf);
  } catch {
    // not cached yet — download it
  }
  const res = await bungieFetchRaw(db.path);
  if (!res.ok) {
    throw new Error(`Failed to download gear asset DB ${db.path}: ${res.status}`);
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  const bytes = unwrapDatabase(raw);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(target, bytes);
  return bytes;
}

// Keep opened databases in memory keyed by cache path.
const openDbs = new Map<string, Database>();

async function openDb(db: GearAssetDatabase): Promise<Database> {
  const key = cacheFileFor(db);
  const existing = openDbs.get(key);
  if (existing) return existing;

  const SQL = await getSql();
  const bytes = await ensureDbFile(db);
  const database = new SQL.Database(bytes);
  openDbs.set(key, database);
  return database;
}

/**
 * Look up the gear-asset definition for an item hash. Searches the manifest's
 * gear-asset databases (highest version first) and returns the first match.
 */
export async function getGearAsset(
  itemHash: number,
): Promise<GearAssetDefinition | null> {
  const manifest = await getManifest();
  const signedId = hashToSignedId(itemHash);

  const dbs = [...manifest.gearAssetDatabases].sort(
    (a, b) => b.version - a.version,
  );

  for (const db of dbs) {
    const database = await openDb(db);
    const stmt = database.prepare(
      "SELECT json FROM DestinyGearAssetsDefinition WHERE id = :id",
    );
    stmt.bind({ ":id": signedId });
    let json: string | null = null;
    if (stmt.step()) {
      json = stmt.getAsObject().json as string;
    }
    stmt.free();

    if (json) {
      const raw = JSON.parse(json) as GearAssetDefinition["raw"];
      return { raw, content: raw.content ?? [] };
    }
  }

  return null;
}

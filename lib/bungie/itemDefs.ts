/**
 * DestinyInventoryItemDefinition ingestion + search index.
 *
 * The full item table is large (tens of MB, ~40k entries), so we download it
 * once, build a trimmed index of just the renderable gear (weapons + armor)
 * with the handful of fields the browser needs, and cache that to disk. Both
 * the raw table download and the trimmed index are version-keyed against the
 * manifest and only rebuilt when Bungie ships a new manifest version.
 */
import { promises as fs } from "fs";
import path from "path";
import { bungieFetchRaw } from "./client";
import { getManifest } from "./manifest";

export type SlotKey =
  | "kinetic"
  | "energy"
  | "power"
  | "helmet"
  | "gauntlets"
  | "chest"
  | "legs"
  | "classItem";

/** Well-known equipment bucket hashes -> slot. Avoids loading the bucket table. */
const SLOT_BUCKETS: Record<number, SlotKey> = {
  1498876634: "kinetic",
  2465295065: "energy",
  953998645: "power",
  3448274439: "helmet",
  3551918588: "gauntlets",
  14239492: "chest",
  20886954: "legs",
  1585787867: "classItem",
};

const ARMOR_SLOTS = new Set<SlotKey>([
  "helmet",
  "gauntlets",
  "chest",
  "legs",
  "classItem",
]);

const DESTINY_ITEM_TYPE = { ARMOR: 2, WEAPON: 3, SHADER: 19 } as const;

export type ItemKind = "weapon" | "armor" | "shader";

export interface ItemIndexEntry {
  hash: number;
  name: string;
  /** proxied icon URL (or null) */
  icon: string | null;
  slot: SlotKey | null;
  kind: ItemKind;
  tier: string;
  /** 0 Titan, 1 Hunter, 2 Warlock, 3 any (weapons) */
  classType: number;
}

interface ItemIndex {
  version: string;
  items: ItemIndexEntry[];
}

const CACHE_DIR = path.join(process.cwd(), "data", "cache");
const INDEX_CACHE = path.join(CACHE_DIR, "item-index.json");

let memo: ItemIndex | null = null;

function proxyIcon(iconPath: string | undefined): string | null {
  if (!iconPath) return null;
  return `/api/asset?path=${encodeURIComponent(iconPath)}`;
}

async function readCache(): Promise<ItemIndex | null> {
  try {
    return JSON.parse(await fs.readFile(INDEX_CACHE, "utf8")) as ItemIndex;
  } catch {
    return null;
  }
}

function buildIndex(
  version: string,
  table: Record<string, unknown>,
): ItemIndex {
  const items: ItemIndexEntry[] = [];

  for (const def of Object.values(table)) {
    const item = def as any;
    if (item.redacted) continue;
    const name: string = item.displayProperties?.name ?? "";
    if (!name) continue;

    const itemType: number = item.itemType ?? 0;
    const isWeapon = itemType === DESTINY_ITEM_TYPE.WEAPON;
    const isArmor = itemType === DESTINY_ITEM_TYPE.ARMOR;
    const isShader =
      itemType === DESTINY_ITEM_TYPE.SHADER &&
      item.plug?.plugCategoryIdentifier === "shader";

    let slot: SlotKey | null = null;
    let kind: ItemKind;
    if (isWeapon || isArmor) {
      const bucketHash: number = item.inventory?.bucketTypeHash ?? 0;
      slot = SLOT_BUCKETS[bucketHash] ?? null;
      if (!slot) continue; // only equippable gear in known slots
      if (isArmor && !ARMOR_SLOTS.has(slot)) continue;
      if (isWeapon && ARMOR_SLOTS.has(slot)) continue;
      kind = isWeapon ? "weapon" : "armor";
    } else if (isShader) {
      kind = "shader";
    } else {
      continue;
    }

    items.push({
      hash: item.hash,
      name,
      icon: proxyIcon(item.displayProperties?.icon),
      slot,
      kind,
      tier: item.inventory?.tierTypeName ?? "",
      classType: item.classType ?? 3,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return { version, items };
}

/** Ensure the trimmed item index exists for the current manifest version. */
export async function getItemIndex(force = false): Promise<ItemIndex> {
  const manifest = await getManifest();
  if (memo && memo.version === manifest.version && !force) return memo;

  if (!force) {
    const cached = await readCache();
    if (cached && cached.version === manifest.version) {
      memo = cached;
      return cached;
    }
  }

  const tablePath = manifest.componentPaths?.DestinyInventoryItemDefinition;
  if (!tablePath) {
    throw new Error("Manifest has no DestinyInventoryItemDefinition path");
  }

  const res = await bungieFetchRaw(tablePath);
  if (!res.ok) {
    throw new Error(`Failed to download item definitions: ${res.status}`);
  }
  const table = (await res.json()) as Record<string, unknown>;

  const index = buildIndex(manifest.version, table);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(INDEX_CACHE, JSON.stringify(index), "utf8");
  memo = index;
  return index;
}

export interface ItemSearchParams {
  q?: string;
  slot?: SlotKey;
  kind?: ItemKind;
  classType?: number;
  limit?: number;
}

export async function searchItems(
  params: ItemSearchParams,
): Promise<{ total: number; items: ItemIndexEntry[] }> {
  const index = await getItemIndex();
  const q = params.q?.trim().toLowerCase();
  const limit = Math.min(params.limit ?? 60, 200);

  let matches = index.items;
  if (params.slot) matches = matches.filter((i) => i.slot === params.slot);
  if (params.kind) matches = matches.filter((i) => i.kind === params.kind);
  if (params.classType !== undefined && params.classType !== 3) {
    // include the item's own class + class-agnostic (3) armor
    matches = matches.filter(
      (i) => i.classType === params.classType || i.classType === 3,
    );
  }
  if (q) matches = matches.filter((i) => i.name.toLowerCase().includes(q));

  return { total: matches.length, items: matches.slice(0, limit) };
}

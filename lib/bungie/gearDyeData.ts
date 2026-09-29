/** Loads gear material data from Bungie. Field mapping: parseGearDyes.ts. */
import { getGearAsset } from "./gearAsset";
import { getManifest, cdnUrl } from "./manifest";
import { bungieFetch, bungieFetchRaw } from "./client";
import { parseDyes, selectDyeChannels, type DyeTranslation, type GearDyes } from "./parseGearDyes";
export type { DyeTint, SlotDye, GearDyes } from "./parseGearDyes";

export interface ItemGear {
  dyes: GearDyes;
  /** locked_dyes — always render regardless of an applied shader (exotics). */
  lockedDyes: GearDyes;
  /**
   * Number of geometry entries that make up the base arrangement. Content lists
   * base + override geometries; we render only the first `baseGeometryCount`.
   * null = no arrangement info (render everything).
   */
  baseGeometryCount: number | null;
  /** debug: raw default_dyes array (to inspect slot_type_index / change-color mapping) */
  rawDefaultDyes?: unknown;
  /** debug: the complete parsed gear .js payload (only kept in memory cache). */
  rawGearFile?: unknown;
}

// Small in-memory cache — loadGearModel resolves gear for the item (arrangement
// + dyes) and often the shader too; avoid re-fetching the same gear file.
const gearCache = new Map<number, ItemGear>();

const translationCache = new Map<number, Promise<DyeTranslation>>();
function getDyeTranslation(hash: number): Promise<DyeTranslation> {
  const cached = translationCache.get(hash);
  if (cached) return cached;
  const request = bungieFetch<{ translationBlock?: DyeTranslation }>(
    `/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`,
  ).then((item) => item.translationBlock ?? {}).catch((error) => {
    translationCache.delete(hash);
    throw error;
  });
  translationCache.set(hash, request);
  return request;
}

/** Resolve all supported gear families through the current manifest's channels. */
export async function getShaderDyesForItem(shaderHash: number, itemHash: number): Promise<GearDyes> {
  const [gear, shader, target] = await Promise.all([
    getItemGear(shaderHash), getDyeTranslation(shaderHash), getDyeTranslation(itemHash),
  ]);
  const raw = gear.rawGearFile as { default_dyes?: unknown; custom_dyes?: unknown } | undefined;
  return {
    ...parseDyes(selectDyeChannels(raw?.default_dyes, shader, target)),
    ...parseDyes(selectDyeChannels(raw?.custom_dyes, shader, target)),
  };
}

/** Parse the gear file for a hash: dyes + base-arrangement geometry count. */
export async function getItemGear(hash: number): Promise<ItemGear> {
  const cached = gearCache.get(hash);
  if (cached) return cached;

  const empty: ItemGear = { dyes: {}, lockedDyes: {}, baseGeometryCount: null };
  const gearAsset = await getGearAsset(hash);

  // The gear `.js` filename can sit in a few places depending on the asset
  // shape. Check all known locations rather than only raw.gear[0]:
  //   - raw.gear[]            (top-level, common)
  //   - content[].gear[]      (per-content-entry)
  // Some assets list multiple gear files; the dye/arrangement data is in the
  // first that exists.
  const raw = gearAsset?.raw as
    | { gear?: string[]; content?: { gear?: string[] }[] }
    | undefined;
  const content = gearAsset?.content as { gear?: string[] }[] | undefined;
  const gearFile =
    raw?.gear?.[0] ??
    raw?.content?.[0]?.gear?.[0] ??
    content?.[0]?.gear?.[0] ??
    content?.find((c) => c?.gear?.length)?.gear?.[0];

  if (!gearFile) {
    // No gear file anywhere on this asset. Cache and return empty — but keep
    // the raw asset on the result so the debug endpoint can show WHY (the
    // caller can inspect what shape getGearAsset actually returned).
    const noGear: ItemGear = {
      ...empty,
      rawDefaultDyes: { _noGearFile: true, asset: gearAsset ?? null },
    };
    gearCache.set(hash, noGear);
    return noGear;
  }

  const manifest = await getManifest();
  const res = await bungieFetchRaw(cdnUrl(manifest.gearCdn.Gear, gearFile));
  if (!res.ok) {
    const failed: ItemGear = {
      ...empty,
      rawDefaultDyes: { _fetchFailed: true, status: res.status, gearFile },
    };
    gearCache.set(hash, failed);
    return failed;
  }

  const data = JSON.parse(await res.text()) as {
    default_dyes?: unknown;
    custom_dyes?: unknown;
    locked_dyes?: unknown;
    art_content_sets?: {
      arrangement?: {
        gear_set?: {
          base_art_arrangement?: { geometry_hashes?: string[] };
        };
      };
    }[];
  };

  const base =
    data.art_content_sets?.[0]?.arrangement?.gear_set?.base_art_arrangement;
  const dyes = { ...parseDyes(data.default_dyes), ...parseDyes(data.custom_dyes) };
  // Locked dyes always render regardless of an applied shader (exotics that
  // ignore shaders on certain regions). Same schema as default_dyes.
  const lockedDyes = parseDyes(data.locked_dyes);

  // If the gear file loaded but carried no default_dyes, this is an item whose
  // default appearance is defined by a shader plug (common for armor). The
  // item's own gear file has geometry but no colours — the dyes live in the
  // item definition's translationBlock.defaultDyes, which point at a shader's
  // gear file. Resolving that requires the item def + a shader-hash -> gear-file
  // lookup. NOT done here because it needs the manifest item definition, which
  // this function doesn't fetch.
  //
  // TODO(shader-default-dyes): when Object.keys(dyes).length === 0, fetch
  //   DestinyInventoryItemDefinition[hash].translationBlock.defaultDyes, resolve
  //   each channel's dye hash to its shader gear file, and parseDyes THAT.

  const result: ItemGear = {
    dyes,
    lockedDyes,
    baseGeometryCount: base?.geometry_hashes?.length ?? null,
    // debug: distinguish "gear file had no dyes" from "parse produced none".
    rawDefaultDyes:
      data.default_dyes ?? { _noDefaultDyesInGearFile: true, gearFile },
    rawGearFile: data,
  };
  gearCache.set(hash, result);
  return result;
}

/** Convenience: just the per-slot dye colours for a hash. */
export async function getGearDyes(hash: number): Promise<GearDyes> {
  return (await getItemGear(hash)).dyes;
}

/** Convenience: just the locked-dye slots for a hash (usually empty). */
export async function getLockedDyes(hash: number): Promise<GearDyes> {
  return (await getItemGear(hash)).lockedDyes;
}

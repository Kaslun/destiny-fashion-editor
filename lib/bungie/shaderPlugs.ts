import type { ItemIndexEntry } from "./itemDefs";

interface ShaderDefinition {
  hash?: number;
  redacted?: boolean;
  itemType?: number;
  plug?: { plugCategoryIdentifier?: string };
  displayProperties?: { name?: string; icon?: string };
  inventory?: { tierTypeName?: string };
  translationBlock?: {
    defaultDyes?: { dyeHash: number }[];
    customDyes?: { dyeHash: number }[];
  };
}

/** Keep all shader hashes, including reissues omitted by catalog deduplication.
 * Empty/default shader plugs carry no dye references and mean the item default.
 */
export function collectShaderPlugs(table: Record<string, unknown>): Record<number, ItemIndexEntry> {
  const shaders: Record<number, ItemIndexEntry> = {};
  for (const raw of Object.values(table)) {
    const d = raw as ShaderDefinition;
    if (!d || d.redacted || !d.hash || d.itemType !== 19 || d.plug?.plugCategoryIdentifier !== "shader") continue;
    const dyes = [...(d.translationBlock?.defaultDyes ?? []), ...(d.translationBlock?.customDyes ?? [])];
    if (!dyes.some((dye) => dye.dyeHash > 0)) continue;
    shaders[d.hash] = {
      hash: d.hash, name: d.displayProperties?.name ?? "Shader",
      icon: d.displayProperties?.icon ? `/api/asset?path=${encodeURIComponent(d.displayProperties.icon)}` : null,
      slot: null, kind: "shader", tier: d.inventory?.tierTypeName ?? "", classType: 3,
    };
  }
  return shaders;
}

export function equippedShader(plugHashes: number[], shaders: Record<number, ItemIndexEntry>): number | null {
  return plugHashes.find((hash) => Object.hasOwn(shaders, hash)) ?? null;
}

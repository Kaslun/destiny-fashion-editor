/**
 * Shared sort options for the ornament / shader browsers.
 *
 * The item index already ships name-ascending, so "name-asc" is the natural
 * default; the others re-order a copy on the client (the full match set is small
 * once paginated).
 */
import type { ItemEntry } from "./ItemBrowser";

export type SortKey = "name-asc" | "name-desc" | "rarity";

export const SORTS: { value: SortKey; label: string }[] = [
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
  { value: "rarity", label: "Rarity" },
];

// Highest rarity first; unknown tiers sink to the bottom.
const TIER_RANK: Record<string, number> = {
  Exotic: 0,
  Legendary: 1,
  Rare: 2,
  Uncommon: 3,
  Common: 4,
};

export function sortItems(items: ItemEntry[], sort: SortKey): ItemEntry[] {
  const arr = [...items];
  switch (sort) {
    case "name-desc":
      return arr.sort((a, b) => b.name.localeCompare(a.name));
    case "rarity":
      return arr.sort(
        (a, b) =>
          (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99) ||
          a.name.localeCompare(b.name),
      );
    case "name-asc":
    default:
      return arr.sort((a, b) => a.name.localeCompare(b.name));
  }
}

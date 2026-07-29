"use client";

/**
 * Slot-based catalog browser. Pick a slot, search by name, and click an item to
 * load it into the viewport. Backed by /api/items.
 *
 * In the editor the slot and class are driven by the character (fixedSlot /
 * fixedClassType), leaving just the search row and the paginated icon grid —
 * the browse panel of the appearance screen.
 */
import { useEffect, useMemo, useState } from "react";
import PaginatedIconGrid from "./PaginatedIconGrid";
import { SORTS, sortItems, type SortKey } from "./itemSort";

export interface ItemEntry {
  hash: number;
  name: string;
  icon: string | null;
  slot: string | null;
  kind: "weapon" | "armor" | "shader" | "ornament";
  tier: string;
  classType: number;
}

// classType 3 = "All" (no filter). Hunter is the default per the primary user.
const CLASSES: { value: number; label: string }[] = [
  { value: 3, label: "All Classes" },
  { value: 0, label: "Titan" },
  { value: 1, label: "Hunter" },
  { value: 2, label: "Warlock" },
];

const RARITIES = ["Exotic", "Legendary", "Rare", "Uncommon", "Common"];

const SLOTS: { key: string; label: string }[] = [
  { key: "kinetic", label: "Kinetic" },
  { key: "energy", label: "Energy" },
  { key: "power", label: "Power" },
  { key: "helmet", label: "Helmet" },
  { key: "gauntlets", label: "Arms" },
  { key: "chest", label: "Chest" },
  { key: "legs", label: "Legs" },
  { key: "classItem", label: "Class" },
];

const TIER_COLOR: Record<string, string> = {
  Exotic: "#ceae33",
  Legendary: "#5a3e70",
  Rare: "#4f7ba8",
  Uncommon: "#3a7d44",
  Common: "#c3bcb4",
};

export function tierColor(tier: string): string {
  return TIER_COLOR[tier] ?? "var(--fx-line)";
}

interface Props {
  selectedHash: number | null;
  onSelect: (item: ItemEntry) => void;
  /** Lock the browser to one slot (hides the slot tabs) — for the character editor. */
  fixedSlot?: string;
  /** Lock the class filter (hides the class dropdown) — follows the character's class. */
  fixedClassType?: number;
  /** Only show favourited items. */
  favoritesOnly?: boolean;
  favorites?: Set<number>;
  onToggleFavorite?: (hash: number) => void;
}

export default function ItemBrowser({
  selectedHash,
  onSelect,
  fixedSlot,
  fixedClassType,
  favoritesOnly = false,
  favorites,
  onToggleFavorite,
}: Props) {
  const [slot, setSlot] = useState(fixedSlot ?? "kinetic");
  const [q, setQ] = useState("");
  const [classType, setClassType] = useState(fixedClassType ?? 1); // Hunter by default
  const [tier, setTier] = useState(""); // "" = all rarities
  const [sort, setSort] = useState<SortKey>("name-asc");

  // Follow externally-controlled slot / class when provided.
  useEffect(() => {
    if (fixedSlot) setSlot(fixedSlot);
  }, [fixedSlot]);
  useEffect(() => {
    if (fixedClassType !== undefined) setClassType(fixedClassType);
  }, [fixedClassType]);
  const [items, setItems] = useState<ItemEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const base = favoritesOnly && favorites ? items.filter((i) => favorites.has(i.hash)) : items;
    return sortItems(base, sort);
  }, [items, sort, favoritesOnly, favorites]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ slot, q, limit: "500" });
        if (classType !== 3) params.set("classType", String(classType));
        if (tier) params.set("tier", tier);
        const res = await fetch(`/api/items?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? `search failed (${res.status})`);
        setItems(data.items);
        setTotal(data.total);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [slot, q, classType, tier]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Slot tabs (hidden when locked to a single slot) */}
      {!fixedSlot && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
          {SLOTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSlot(s.key)}
              className="fx-btn"
              style={{ padding: "6px 10px", ...(slot === s.key ? { borderColor: "#fff" } : {}) }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Search + filters */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginLeft: 40,
          marginBottom: 18,
          maxWidth: 740,
        }}
      >
        <input
          className="fx-input"
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        {fixedClassType === undefined && (
          <select
            className="fx-input fx-select"
            style={{ cursor: "pointer" }}
            value={classType}
            onChange={(e) => setClassType(Number(e.target.value))}
          >
            {CLASSES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <select
          className="fx-input fx-select"
          style={{ cursor: "pointer" }}
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          title="Rarity"
        >
          <option value="">All rarities</option>
          {RARITIES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          className="fx-input fx-select"
          style={{ cursor: "pointer" }}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          title="Sort"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span
          className="mono"
          style={{
            flexShrink: 0,
            fontSize: 11,
            color: "var(--fx-ink-dim)",
            letterSpacing: "0.06em",
          }}
        >
          {loading ? "…" : `${shown.length}${shown.length < total ? `/${total}` : ""}`}
        </span>
      </div>

      {error && (
        <p className="mono" style={{ color: "var(--fx-danger)", fontSize: 12, margin: "0 0 8px" }}>
          {error}
        </p>
      )}

      <PaginatedIconGrid
        items={shown}
        selectedHash={selectedHash}
        onSelect={onSelect}
        restBorder={(item) => tierColor(item.tier)}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
      />
    </div>
  );
}

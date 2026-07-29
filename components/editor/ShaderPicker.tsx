"use client";

/**
 * Shader search + picker. Applying a shader recolors the current item via the
 * gear-dye pipeline. Backed by /api/items?kind=shader.
 *
 * Selection hands back the whole entry (not just the hash) so the caller can
 * show the shader's icon and name next to the piece it's applied to. Clearing
 * is the caller's "Default" control, which sits above the browser.
 */
import { useEffect, useMemo, useState } from "react";
import type { ItemEntry } from "./ItemBrowser";
import PaginatedIconGrid from "./PaginatedIconGrid";
import { SORTS, sortItems, type SortKey } from "./itemSort";

interface Props {
  selectedShaderHash: number | null;
  onSelect: (shader: ItemEntry) => void;
  favoritesOnly?: boolean;
  favorites?: Set<number>;
  onToggleFavorite?: (hash: number) => void;
}

export default function ShaderPicker({
  selectedShaderHash,
  onSelect,
  favoritesOnly = false,
  favorites,
  onToggleFavorite,
}: Props) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortKey>("name-asc");

  const shown = useMemo(() => {
    const base = favoritesOnly && favorites ? items.filter((i) => favorites.has(i.hash)) : items;
    return sortItems(base, sort);
  }, [items, sort, favoritesOnly, favorites]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/items?kind=shader&q=${encodeURIComponent(q)}&limit=1000`,
        );
        const data = await res.json();
        if (cancelled) return;
        setItems(data.items ?? []);
        setTotal(data.total ?? 0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
          placeholder="Search shaders"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
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

      <PaginatedIconGrid
        items={shown}
        selectedHash={selectedShaderHash}
        onSelect={onSelect}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
      />
    </div>
  );
}

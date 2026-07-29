"use client";

/**
 * A responsive, paginated icon grid.
 *
 * Instead of one long scrolling grid, this measures its own available area and
 * lays out only as many whole columns × whole rows of icons as fit cleanly —
 * never a partial row that would clip or force a scrollbar. The remaining items
 * spill onto further pages, navigated with the chevrons flanking the grid and
 * the page dashes beneath it. Page size recomputes on resize, so the layout
 * stays neat at any panel width/height.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ItemEntry } from "./ItemBrowser";

interface Props {
  items: ItemEntry[];
  selectedHash: number | null;
  onSelect: (item: ItemEntry) => void;
  /** Minimum cell edge in px — drives how many columns fit. */
  cellMin?: number;
  /** Grid gap in px. */
  gap?: number;
  /** Resting (unselected) border color for an item's cell. */
  restBorder?: (item: ItemEntry) => string;
  /** Hashes marked as favourites — rendered with a star. */
  favorites?: Set<number>;
  /** Shift-click a cell to flip its favourite state. */
  onToggleFavorite?: (hash: number) => void;
}

/** Cap on rendered page dashes before falling back to a numeric readout. */
const MAX_DASHES = 14;

export default function PaginatedIconGrid({
  items,
  selectedHash,
  onSelect,
  cellMin = 74,
  gap = 9,
  restBorder = () => "var(--fx-line)",
  favorites,
  onToggleFavorite,
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [page, setPage] = useState(0);

  // Track the measured area so the page size can follow the panel size.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setDims({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit whole columns to the width, then whole rows of that cell size to the
  // height. Flooring both keeps every visible row complete (no clipping/scroll).
  const { cols, pageSize, cellSize } = useMemo(() => {
    if (dims.w <= 0 || dims.h <= 0) {
      return { cols: 0, pageSize: 0, cellSize: 0 };
    }
    const c = Math.max(1, Math.floor((dims.w + gap) / (cellMin + gap)));
    const cell = (dims.w - (c - 1) * gap) / c;
    const r = Math.max(1, Math.floor((dims.h + gap) / (cell + gap)));
    return { cols: c, pageSize: c * r, cellSize: cell };
  }, [dims, cellMin, gap]);

  // A new result set (search/filter change) starts back at the first page.
  useEffect(() => {
    setPage(0);
  }, [items]);

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(items.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const pageItems = pageSize > 0 ? items.slice(start, start + pageSize) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 14, flex: 1, minHeight: 0 }}>
        <button
          className="fx-arrow"
          aria-label="Previous page"
          disabled={safePage <= 0}
          onClick={() => setPage(safePage - 1)}
        >
          ◀
        </button>

        <div ref={areaRef} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
          {pageSize > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gridAutoRows: `${cellSize}px`,
                gap,
                alignContent: "start",
              }}
            >
              {pageItems.map((item) => {
                const fav = favorites?.has(item.hash) ?? false;
                return (
                  <button
                    key={item.hash}
                    className="fx-tile"
                    data-selected={item.hash === selectedHash}
                    title={`${item.name}${item.tier ? ` · ${item.tier}` : ""}${
                      onToggleFavorite ? " — shift-click to favourite" : ""
                    }`}
                    onClick={(e) => {
                      if (e.shiftKey && onToggleFavorite) onToggleFavorite(item.hash);
                      else onSelect(item);
                    }}
                    style={{ borderColor: restBorder(item), overflow: "hidden" }}
                  >
                    <span className="fx-tile__fill" />
                    {item.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.icon} alt={item.name} loading="lazy" />
                    ) : (
                      <span
                        style={{
                          position: "absolute",
                          inset: 0,
                          display: "grid",
                          placeItems: "center",
                          padding: 3,
                          fontSize: 9,
                          lineHeight: 1.2,
                          color: "var(--fx-ink-dim)",
                        }}
                      >
                        {item.name.slice(0, 12)}
                      </span>
                    )}
                    {fav && <span className="fx-tile__fav">★</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          className="fx-arrow"
          aria-label="Next page"
          disabled={safePage >= pageCount - 1}
          onClick={() => setPage(safePage + 1)}
        >
          ▶
        </button>
      </div>

      {pageCount > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginTop: 18,
            flexShrink: 0,
          }}
        >
          {pageCount <= MAX_DASHES ? (
            Array.from({ length: pageCount }, (_, i) => (
              <button
                key={i}
                aria-label={`Page ${i + 1}`}
                onClick={() => setPage(i)}
                style={{
                  width: 26,
                  height: 2,
                  padding: 0,
                  border: "none",
                  cursor: "pointer",
                  background: i === safePage ? "#ffffff" : "var(--fx-ink-faint)",
                }}
              />
            ))
          ) : (
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--fx-ink-dim)", letterSpacing: "0.08em" }}
            >
              {safePage + 1} / {pageCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

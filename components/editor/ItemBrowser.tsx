"use client";

/**
 * Slot-based catalog browser for manual mode. Pick a slot, search by name, and
 * click an item to load it into the viewer. Backed by /api/items.
 */
import { useEffect, useState } from "react";

export interface ItemEntry {
  hash: number;
  name: string;
  icon: string | null;
  slot: string | null;
  kind: "weapon" | "armor" | "shader";
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

function tierColor(tier: string): string {
  return TIER_COLOR[tier] ?? "var(--d2-line)";
}

interface Props {
  selectedHash: number | null;
  onSelect: (item: ItemEntry) => void;
}

export default function ItemBrowser({ selectedHash, onSelect }: Props) {
  const [slot, setSlot] = useState("kinetic");
  const [q, setQ] = useState("");
  const [classType, setClassType] = useState(1); // Hunter by default
  const [tier, setTier] = useState(""); // "" = all rarities
  const [items, setItems] = useState<ItemEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ slot, q, limit: "90" });
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Slot tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
        {SLOTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSlot(s.key)}
            className="d2-btn"
            style={{
              padding: "6px 10px",
              fontSize: 12,
              ...(slot === s.key
                ? { borderColor: "var(--d2-cyan)", color: "var(--d2-cyan-bright)" }
                : {}),
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        className="d2-input"
        placeholder={`Search ${slot}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      {/* Filters: class + rarity */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <select
          className="d2-input"
          style={{ flex: 1, cursor: "pointer" }}
          value={classType}
          onChange={(e) => setClassType(Number(e.target.value))}
        >
          {CLASSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          className="d2-input"
          style={{ flex: 1, cursor: "pointer" }}
          value={tier}
          onChange={(e) => setTier(e.target.value)}
        >
          <option value="">All Rarities</option>
          {RARITIES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div style={{ fontSize: 11, color: "var(--d2-text-faint)", marginBottom: 8 }}>
        {loading ? "Searching…" : `${total} result${total === 1 ? "" : "s"}`}
        {total > items.length && ` (showing ${items.length})`}
      </div>

      {error && (
        <p className="mono" style={{ color: "var(--d2-danger)", fontSize: 12 }}>
          {error}
        </p>
      )}

      {/* Results grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(60px, 1fr))",
          gap: 16,
          overflowY: "auto",
          alignContent: "start",
          flex: 1,
          minHeight: 0,
          padding: 2,
        }}
      >
        {items.map((item) => {
          const active = item.hash === selectedHash;
          return (
            <button
              key={item.hash}
              title={`${item.name} · ${item.tier}`}
              onClick={() => onSelect(item)}
              style={{
                aspectRatio: "1",
                padding: 0,
                cursor: "pointer",
                background: "var(--d2-bg)",
                border: `2px solid ${active ? "var(--d2-cyan)" : tierColor(item.tier)}`,
                boxShadow: active ? "0 0 8px rgba(79,208,224,0.6)" : "none",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {item.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.icon}
                  alt={item.name}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <span style={{ fontSize: 9, color: "var(--d2-text-faint)" }}>
                  {item.name.slice(0, 6)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

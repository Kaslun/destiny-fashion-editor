"use client";

/**
 * Shader search + picker. Applying a shader recolors the current item via the
 * gear-dye pipeline. Backed by /api/items?kind=shader.
 */
import { useEffect, useState } from "react";
import type { ItemEntry } from "./ItemBrowser";

interface Props {
  selectedShaderHash: number | null;
  onSelect: (shaderHash: number | null) => void;
}

export default function ShaderPicker({ selectedShaderHash, onSelect }: Props) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/items?kind=shader&q=${encodeURIComponent(q)}&limit=90`,
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <input
        className="d2-input"
        placeholder="Search shaders…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button
          className="d2-btn"
          onClick={() => onSelect(null)}
          style={{
            padding: "5px 10px",
            fontSize: 12,
            ...(selectedShaderHash === null
              ? { borderColor: "var(--d2-cyan)", color: "var(--d2-cyan-bright)" }
              : {}),
          }}
        >
          No Shader
        </button>
        <span style={{ fontSize: 11, color: "var(--d2-text-faint)" }}>
          {loading ? "Searching…" : `${total} shaders`}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))",
          gap: 12,
          overflowY: "auto",
          alignContent: "start",
          flex: 1,
          minHeight: 0,
          padding: 2,
        }}
      >
        {items.map((s) => {
          const active = s.hash === selectedShaderHash;
          return (
            <button
              key={s.hash}
              title={s.name}
              onClick={() => onSelect(s.hash)}
              style={{
                aspectRatio: "1",
                padding: 0,
                cursor: "pointer",
                background: "var(--d2-bg)",
                border: `2px solid ${active ? "var(--d2-cyan)" : "var(--d2-line)"}`,
                boxShadow: active ? "0 0 8px rgba(79,208,224,0.6)" : "none",
                overflow: "hidden",
              }}
            >
              {s.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.icon}
                  alt={s.name}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <span style={{ fontSize: 9 }}>{s.name.slice(0, 6)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

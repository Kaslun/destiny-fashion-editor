"use client";

/**
 * Manual-mode editor. Browse the full weapon/armor catalog by slot, search by
 * name, and render any item in the 3D viewport. (Single-item render for now;
 * full multi-slot character assembly on a skinned rig is the next milestone.)
 */
import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import GearModel, { type LoadPath } from "@/components/viewer/GearModel";
import ItemBrowser, { type ItemEntry } from "@/components/editor/ItemBrowser";
import ShaderPicker from "@/components/editor/ShaderPicker";
import AppHeader from "@/components/ui/AppHeader";

type BrowseMode = "gear" | "shader";

const ModelViewer = dynamic(() => import("@/components/viewer/ModelViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ padding: 24, color: "var(--d2-text-dim)" }}>Booting viewport…</div>
  ),
});

export default function EditorPage() {
  const [selected, setSelected] = useState<ItemEntry | null>(null);
  const [shaderHash, setShaderHash] = useState<number | null>(null);
  const [mode, setMode] = useState<BrowseMode>("gear");
  const [path, setPath] = useState<LoadPath | null>(null);

  const onSelect = useCallback((item: ItemEntry) => {
    setSelected(item);
    setPath(null);
  }, []);

  const onStatus = useCallback((s: { path: LoadPath }) => setPath(s.path), []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppHeader title="Manual Editor" subtitle="Fashion · Manual Mode" />
      <main className="poc-main" style={{ height: "auto", flex: 1, minHeight: 0 }}>
      {/* Viewport */}
      <section className="poc-viewport">
        <div className="d2-frame" />
        {selected ? (
          <ModelViewer>
            <GearModel
              itemHash={selected.hash}
              shaderHash={shaderHash}
              onStatus={onStatus}
            />
          </ModelViewer>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--d2-text-faint)",
              textAlign: "center",
              padding: 24,
            }}
          >
            <div>
              <p className="d2-eyebrow">Manual Mode</p>
              <p>Pick a slot and choose an item to preview it in 3D.</p>
            </div>
          </div>
        )}

        {selected && <ItemCard item={selected} path={path} shaderApplied={!!shaderHash} />}
      </section>

      {/* Browser panel */}
      <aside className="editor-aside">
        {/* Gear / Shader mode toggle */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button
            className={`d2-btn ${mode === "gear" ? "d2-btn--primary" : ""}`}
            style={{ flex: 1, padding: "8px 0", fontSize: 13 }}
            onClick={() => setMode("gear")}
          >
            Gear
          </button>
          <button
            className={`d2-btn ${mode === "shader" ? "d2-btn--primary" : ""}`}
            style={{ flex: 1, padding: "8px 0", fontSize: 13 }}
            onClick={() => setMode("shader")}
            disabled={!selected}
            title={selected ? "" : "Select an item first"}
          >
            Shaders
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {mode === "gear" ? (
            <ItemBrowser selectedHash={selected?.hash ?? null} onSelect={onSelect} />
          ) : (
            <ShaderPicker selectedShaderHash={shaderHash} onSelect={setShaderHash} />
          )}
        </div>
      </aside>
      </main>
    </div>
  );
}

const TIER_COLOR: Record<string, string> = {
  Exotic: "#ceae33",
  Legendary: "#5a3e70",
  Rare: "#4f7ba8",
  Uncommon: "#3a7d44",
  Common: "#8a929c",
};

/** D2-style item detail card overlaid on the viewport (see FUI item tooltip). */
function ItemCard({
  item,
  path,
  shaderApplied,
}: {
  item: ItemEntry;
  path: LoadPath | null;
  shaderApplied: boolean;
}) {
  const tier = TIER_COLOR[item.tier] ?? "var(--d2-line)";
  return (
    <div
      className="d2-panel"
      style={{
        position: "absolute",
        top: 26,
        left: 26,
        width: 250,
        padding: 0,
        background: "rgba(10,12,15,0.9)",
        overflow: "hidden",
      }}
    >
      {/* tier-coloured header (darkened so the name stays legible on any tier) */}
      <div
        style={{
          background: `color-mix(in srgb, ${tier} 55%, #0a0c0f)`,
          borderBottom: `1px solid ${tier}`,
          padding: "8px 12px",
        }}
      >
        <div className="d2-tooltip-header">{item.name}</div>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--d2-text-dim)",
          }}
        >
          {item.tier} · {item.slot ?? item.kind}
        </div>
      </div>

      <div style={{ padding: "8px 12px", display: "grid", gap: 4 }}>
        {path && (
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.06em",
              color:
                path === "real"
                  ? "var(--d2-ok)"
                  : path === "fallback"
                    ? "var(--d2-gold)"
                    : "var(--d2-cyan)",
            }}
          >
            {path === "loading"
              ? "LOADING…"
              : path === "real"
                ? "● REAL GEAR ASSET"
                : "● NO 3D — FALLBACK"}
          </div>
        )}
        {shaderApplied && (
          <div style={{ fontSize: 10, letterSpacing: "0.06em", color: "var(--d2-cyan)" }}>
            ◆ SHADER APPLIED
          </div>
        )}
      </div>
      <div className="d2-hazard" />
    </div>
  );
}

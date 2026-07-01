"use client";

/**
 * Manual-mode editor. Browse the full weapon/armor catalog by slot, search by
 * name, and render any item in the 3D viewport. (Single-item render for now;
 * full multi-slot character assembly on a skinned rig is the next milestone.)
 */
import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import GearModel, { type LoadPath } from "@/components/viewer/GearModel";
import ItemBrowser, { type ItemEntry } from "@/components/editor/ItemBrowser";

const ModelViewer = dynamic(() => import("@/components/viewer/ModelViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ padding: 24, color: "var(--d2-text-dim)" }}>Booting viewport…</div>
  ),
});

export default function EditorPage() {
  const [selected, setSelected] = useState<ItemEntry | null>(null);
  const [path, setPath] = useState<LoadPath | null>(null);

  const onSelect = useCallback((item: ItemEntry) => {
    setSelected(item);
    setPath(null);
  }, []);

  const onStatus = useCallback((s: { path: LoadPath }) => setPath(s.path), []);

  return (
    <main className="poc-main">
      {/* Viewport */}
      <section className="poc-viewport">
        {selected ? (
          <ModelViewer>
            <GearModel itemHash={selected.hash} onStatus={onStatus} />
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

        {selected && (
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 16,
              padding: "8px 14px",
              border: "1px solid var(--d2-line)",
              background: "rgba(10,12,15,0.82)",
            }}
          >
            <div className="d2-eyebrow" style={{ fontSize: 10 }}>
              {selected.tier} · {selected.slot}
            </div>
            <div style={{ fontFamily: "var(--font-condensed)", fontSize: 20, letterSpacing: "0.04em" }}>
              {selected.name}
            </div>
            {path && (
              <div
                style={{
                  fontSize: 10,
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
          </div>
        )}
      </section>

      {/* Browser panel */}
      <aside className="editor-aside">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <p className="d2-eyebrow">Destiny Fashion</p>
            <h1 style={{ fontSize: 24 }}>Manual Editor</h1>
          </div>
          <Link href="/" style={{ fontSize: 12 }}>
            ← Home
          </Link>
        </div>
        <hr className="d2-rule" />
        <div style={{ flex: 1, minHeight: 0 }}>
          <ItemBrowser selectedHash={selected?.hash ?? null} onSelect={onSelect} />
        </div>
      </aside>
    </main>
  );
}

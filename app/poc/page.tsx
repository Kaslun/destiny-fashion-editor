"use client";

/**
 * Step-1 verification harness.
 *
 * Enter an item hash -> the full pipeline resolves it (manifest -> gear-asset
 * SQLite -> proxied .tgxm geometry -> Three.js) and renders it. The panel
 * reports whether we're on the REAL asset path or the stylized FALLBACK, plus
 * the resolved files and metadata summary for empirical tuning.
 */
import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import GearModel, { type LoadPath } from "@/components/viewer/GearModel";
import type { GearModelDebug } from "@/lib/loader/loadGearModel";

// Three.js can't render on the server — load the canvas client-only.
const ModelViewer = dynamic(() => import("@/components/viewer/ModelViewer"), {
  ssr: false,
  loading: () => <div style={{ padding: 24, color: "var(--d2-text-dim)" }}>Booting viewport…</div>,
});

// Default: Gjallarhorn (a well-known exotic that ships mobile gear assets).
const DEFAULT_HASH = "1363886209";

export default function PocPage() {
  const [input, setInput] = useState(DEFAULT_HASH);
  const [activeHash, setActiveHash] = useState<number | null>(null);
  const [path, setPath] = useState<LoadPath | null>(null);
  const [debug, setDebug] = useState<GearModelDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [itemName, setItemName] = useState<string | null>(null);

  const load = useCallback(() => {
    const n = Number(input.trim());
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a numeric item hash.");
      return;
    }
    setError(null);
    setDebug(null);
    setPath(null);
    setItemName(null);
    setActiveHash(n);
    // Resolve the item's display name to label the rendered mesh.
    fetch(`/api/items?hash=${n}`)
      .then((r) => r.json())
      .then((d) => setItemName(d.item?.name ?? null))
      .catch(() => setItemName(null));
  }, [input]);

  const onStatus = useCallback(
    (s: { path: LoadPath; debug?: GearModelDebug; error?: string }) => {
      setPath(s.path);
      if (s.debug) setDebug(s.debug);
      if (s.error) setError(s.error);
    },
    [],
  );

  return (
    <main className="poc-main">
      {/* Viewport */}
      <section className="poc-viewport">
        {activeHash ? (
          <ModelViewer>
            <GearModel itemHash={activeHash} onStatus={onStatus} />
          </ModelViewer>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--d2-text-faint)",
            }}
          >
            <p>Enter an item hash and press LOAD.</p>
          </div>
        )}
        <PathBadge path={path} />
        {itemName && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 16,
              padding: "6px 12px",
              border: "1px solid var(--d2-line)",
              background: "rgba(10,12,15,0.82)",
            }}
          >
            <span className="d2-tooltip-header" style={{ fontSize: 18 }}>
              {itemName}
            </span>
          </div>
        )}
      </section>

      {/* Control panel */}
      <aside className="poc-aside">
        <p className="d2-eyebrow">Gear Asset POC</p>
        <h1 style={{ fontSize: 28, marginTop: 4 }}>Renderer Test</h1>
        <hr className="d2-rule" />

        <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>ITEM HASH</label>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            className="d2-input mono"
            style={{ flex: 1 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="e.g. 1363886209"
          />
          <button className="d2-btn d2-btn--primary" onClick={load}>
            Load
          </button>
        </div>

        {error && (
          <div
            className="d2-panel"
            style={{ padding: 12, marginTop: 14, borderColor: "var(--d2-danger)" }}
          >
            <p className="d2-eyebrow" style={{ color: "var(--d2-danger)" }}>
              Error
            </p>
            <p className="mono" style={{ fontSize: 12, color: "var(--d2-text)", wordBreak: "break-word" }}>
              {error}
            </p>
          </div>
        )}

        {debug && <DebugPanel debug={debug} />}

        <div style={{ marginTop: 24, fontSize: 12, color: "var(--d2-text-faint)", lineHeight: 1.6 }}>
          <p className="d2-eyebrow">Setup</p>
          <p>
            Requires <span className="mono">BUNGIE_API_KEY</span> in{" "}
            <span className="mono">.env.local</span>. Verify credentials at{" "}
            <a href="/api/manifest" target="_blank" rel="noreferrer">
              /api/manifest
            </a>
            .
          </p>
        </div>
      </aside>
    </main>
  );
}

function PathBadge({ path }: { path: LoadPath | null }) {
  if (!path) return null;
  const label =
    path === "loading" ? "LOADING…" : path === "real" ? "REAL GEAR ASSET" : "FALLBACK PROXY";
  const color =
    path === "real" ? "var(--d2-ok)" : path === "fallback" ? "var(--d2-gold)" : "var(--d2-cyan)";
  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        padding: "6px 12px",
        border: `1px solid ${color}`,
        background: "rgba(10,12,15,0.8)",
        color,
        fontFamily: "var(--font-condensed)",
        letterSpacing: "0.12em",
        fontSize: 13,
      }}
    >
      {label}
    </div>
  );
}

function DebugPanel({ debug }: { debug: GearModelDebug }) {
  const rows: [string, string][] = [
    ["Manifest", debug.manifestVersion ?? "—"],
    ["Meshes", String(debug.meshCount)],
    ["Textured", `${debug.texturedMeshCount}/${debug.meshCount}`],
    ["Triangles", debug.totalTriangles.toLocaleString()],
    ["Geometry files", String(debug.geometryFiles.length)],
    ["Texture files", String(debug.textureFiles.length)],
  ];
  return (
    <div className="d2-panel" style={{ padding: 14, marginTop: 16 }}>
      <p className="d2-eyebrow">Resolved</p>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ color: "var(--d2-text-dim)", padding: "3px 0" }}>{k}</td>
              <td className="mono" style={{ textAlign: "right", color: "var(--d2-text)" }}>
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {debug.textureFiles.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--d2-cyan)" }}>
            Texture files
          </summary>
          <ul className="mono" style={{ fontSize: 11, color: "var(--d2-text-dim)", paddingLeft: 16 }}>
            {debug.textureFiles.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </details>
      )}

      {debug.warnings.length > 0 && (
        <details style={{ marginTop: 10 }} open>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--d2-gold)" }}>
            Warnings ({debug.warnings.length})
          </summary>
          <ul className="mono" style={{ fontSize: 11, color: "var(--d2-gold)", paddingLeft: 16 }}>
            {debug.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--d2-cyan)" }}>
          Metadata summary
        </summary>
        <pre
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--d2-text-dim)",
            overflowX: "auto",
            background: "var(--d2-bg)",
            padding: 8,
          }}
        >
          {JSON.stringify(debug.metadataSummaries, null, 2)}
        </pre>
      </details>
    </div>
  );
}

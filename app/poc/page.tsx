"use client";

/**
 * Step-1 verification harness.
 *
 * Enter an item hash -> the full pipeline resolves it (manifest -> gear-asset
 * SQLite -> proxied .tgxm geometry -> Three.js) and renders it. The panel
 * reports whether we're on the REAL asset path or the stylized FALLBACK, plus
 * the resolved files and metadata summary for empirical tuning.
 */
import { useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import type * as THREE from "three";
import GearModel, { type LoadPath } from "@/components/viewer/GearModel";
import type { GearModelDebug } from "@/lib/loader/loadGearModel";
import {
  GEARSTACK_CHANNELS,
  setGearstackDebugChannel,
  REMAP_MODES,
  DEFAULT_REMAP_MODE,
  setRemapMode,
  BAND_DEFAULTS,
  setBandThresholds,
  BAND_MODES,
  DEFAULT_BAND_MODE,
  setBandMode,
  type BandMode,
  type BandTuning,
  type GearstackDebugChannel,
  type RemapMode,
} from "@/lib/materials/gearMaterial";
import {
  dyeSetFromGearDyes,
  dyeForSlot,
  rankSlotsSoftToHard,
} from "@/lib/materials/gearDye";

interface MaterialInfo {
  slot: number;
  label: string;
  cloth: boolean;
  metalness: number;
  fuzz: number;
  primaryHex: string;
  secondaryHex: string;
}

/**
 * Human-readable material label straight from the dye DATA (no name
 * heuristics): the cloth flag, the fuzz amount (Bungie's cloth lobe) and the
 * authored per-tint metalness (material_params[3]).
 */
function materialLabel(cloth: boolean, metalness: number, fuzz: number): string {
  if (cloth || fuzz > 0.01) return "Cloth / Fabric";
  if (metalness >= 0.5) return "Metal";
  if (metalness > 0.05) return "Semi-metal";
  return "Dielectric / Painted";
}

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
  const [debugChannel, setDebugChannelState] = useState<GearstackDebugChannel>(0);
  const [remapMode, setRemapModeState] = useState<RemapMode>(DEFAULT_REMAP_MODE);
  const [bands, setBandsState] = useState<BandTuning>(BAND_DEFAULTS);
  const [bandMode, setBandModeState] = useState<BandMode>(DEFAULT_BAND_MODE);
  const [materials, setMaterials] = useState<MaterialInfo[] | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);

  const onModel = useCallback(
    (group: THREE.Group | null) => {
      modelRef.current = group;
      // A freshly loaded model's materials start at defaults — re-apply the
      // current selections so switching items doesn't silently reset them.
      if (group) {
        if (debugChannel !== 0) setGearstackDebugChannel(group, debugChannel);
        if (remapMode !== DEFAULT_REMAP_MODE) setRemapMode(group, remapMode);
        if (bandMode !== DEFAULT_BAND_MODE) setBandMode(group, bandMode);
        setBandThresholds(group, bands);
      }
    },
    [debugChannel, remapMode, bandMode, bands],
  );

  const selectBandMode = useCallback((mode: BandMode) => {
    setBandModeState(mode);
    if (modelRef.current) setBandMode(modelRef.current, mode);
  }, []);

  const updateBands = useCallback((patch: Partial<BandTuning>) => {
    setBandsState((prev) => {
      const next = { ...prev, ...patch };
      if (next.t1 > next.t2) return prev; // keep the cuts ordered
      if (modelRef.current) setBandThresholds(modelRef.current, patch);
      return next;
    });
  }, []);

  const selectDebugChannel = useCallback((ch: GearstackDebugChannel) => {
    setDebugChannelState(ch);
    if (modelRef.current) setGearstackDebugChannel(modelRef.current, ch);
  }, []);

  const selectRemapMode = useCallback((mode: RemapMode) => {
    setRemapModeState(mode);
    if (modelRef.current) setRemapMode(modelRef.current, mode);
  }, []);

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
    setMaterials(null);
    setActiveHash(n);
    // Resolve the item's display name to label the rendered mesh.
    fetch(`/api/items?hash=${n}`)
      .then((r) => r.json())
      .then((d) => setItemName(d.item?.name ?? null))
      .catch(() => setItemName(null));
    // Resolve each dye slot's material data for the materials panel.
    fetch(`/api/dyes/${n}`)
      .then((r) => r.json())
      .then((d) => {
        const dyeSet = dyeSetFromGearDyes(d.slots ?? {});
        const ordered = rankSlotsSoftToHard(dyeSet);
        const list: MaterialInfo[] = ordered.map((slot) => {
          const dc = dyeForSlot(dyeSet, slot);
          return {
            slot,
            label: materialLabel(dc.cloth, dc.primary.metalness, dc.primary.fuzz),
            cloth: dc.cloth,
            metalness: dc.primary.metalness,
            fuzz: dc.primary.fuzz,
            primaryHex: `#${dc.primary.albedo.getHexString("srgb")}`,
            secondaryHex: `#${dc.secondary.albedo.getHexString("srgb")}`,
          };
        });
        setMaterials(list.length > 0 ? list : null);
      })
      .catch(() => setMaterials(null));
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
            <GearModel itemHash={activeHash} onStatus={onStatus} onModel={onModel} />
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

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
            GEARSTACK CHANNEL
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {GEARSTACK_CHANNELS.map((label, ch) => (
              <button
                key={label}
                className="d2-btn"
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  borderColor: debugChannel === ch ? "var(--d2-cyan)" : undefined,
                  color: debugChannel === ch ? "var(--d2-cyan)" : undefined,
                }}
                onClick={() => selectDebugChannel(ch as GearstackDebugChannel)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
            ROUGHNESS/WEAR REMAP INTERPRETATION
          </label>
          <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
            Bungie doesn&apos;t publish the runtime formula for the dye remap vec4s —
            switch live to compare readings against the in-game look.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {REMAP_MODES.map((label, mode) => (
              <button
                key={label}
                className="d2-btn"
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  borderColor: remapMode === mode ? "var(--d2-cyan)" : undefined,
                  color: remapMode === mode ? "var(--d2-cyan)" : undefined,
                }}
                onClick={() => selectRemapMode(mode as RemapMode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
            SINGLE-SLOT BAND DECODE
          </label>
          <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
            Bungie ships 6 materials per item (3 slots × primary/secondary). The 6-band
            modes cut the dyeable A range into equal (slot, tint) bands; the ordering
            isn&apos;t public, so compare live.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {BAND_MODES.map((label, mode) => (
              <button
                key={label}
                className="d2-btn"
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  borderColor: bandMode === mode ? "var(--d2-cyan)" : undefined,
                  color: bandMode === mode ? "var(--d2-cyan)" : undefined,
                }}
                onClick={() => selectBandMode(mode as BandMode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
              MODE-0 THRESHOLDS (T1/T2)
            </label>
            <button
              className="d2-btn"
              style={{ fontSize: 10, padding: "2px 6px" }}
              onClick={() => updateBands(BAND_DEFAULTS)}
            >
              Reset
            </button>
          </div>
          <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
            For meshes whose stage parts all share one dye slot: raw gearstack A below t1 →
            hardest ranked slot, t1–t2 → middle, above t2 → softest. Compare with the
            &quot;a-channel bands&quot; debug view.
          </p>
          {(["t1", "t2"] as const).map((key) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--d2-text-dim)", width: 20 }}>
                {key}
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={bands[key]}
                onChange={(e) => updateBands({ [key]: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span className="mono" style={{ fontSize: 11, color: "var(--d2-cyan)", width: 44 }}>
                {bands[key].toFixed(3)}
              </span>
            </div>
          ))}
        </div>

        {materials && <MaterialsPanel materials={materials} />}

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

function MaterialsPanel({ materials }: { materials: MaterialInfo[] }) {
  return (
    <div className="d2-panel" style={{ padding: 14, marginTop: 16 }}>
      <p className="d2-eyebrow">Materials in use</p>
      <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 2 }}>
        Ordered softest → hardest. M = authored metalness (material_params[3]),
        F = fuzz amount (material_advanced_params[1]).
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
        {materials.map((m) => (
          <div
            key={m.slot}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
          >
            <span
              title="Primary"
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: m.primaryHex,
                border: "1px solid var(--d2-line)",
                flexShrink: 0,
              }}
            />
            <span
              title="Secondary"
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: m.secondaryHex,
                border: "1px solid var(--d2-line)",
                flexShrink: 0,
              }}
            />
            <span className="mono" style={{ color: "var(--d2-text-dim)", flexShrink: 0 }}>
              Slot {m.slot}
            </span>
            <span style={{ color: "var(--d2-text)", flex: 1 }}>{m.label}</span>
            <span className="mono" style={{ color: "var(--d2-text-faint)", fontSize: 11 }}>
              M{m.metalness.toFixed(2)} F{m.fuzz.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
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

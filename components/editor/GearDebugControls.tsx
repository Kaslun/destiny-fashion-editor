"use client";

/**
 * Shared shader-debug controls for the renderer.
 *
 * These are the live-tuning buttons/sliders originally built for the single-item
 * POC (gearstack channel, roughness/wear remap interpretation, ability-glow,
 * single-slot band decode + thresholds). They're presentational — every control
 * is driven by props so the same panel can tune a single POC item or the whole
 * assembled character in the full editor's debug mode.
 */
import {
  GEARSTACK_CHANNELS,
  REMAP_MODES,
  BAND_DEFAULTS,
  BAND_MODES,
  type BandMode,
  type BandTuning,
  type GearstackDebugChannel,
  type RemapMode,
} from "@/lib/materials/gearMaterial";
import {
  TONE_MAPPING_OPTIONS,
  type ToneMappingKey,
} from "@/components/viewer/toneMapping";

export interface GearDebugControlsProps {
  debugChannel: GearstackDebugChannel;
  onSelectDebugChannel: (ch: GearstackDebugChannel) => void;
  toneMapping: ToneMappingKey;
  onSelectToneMapping: (key: ToneMappingKey) => void;
  roughnessRemapMode: RemapMode;
  onSelectRoughnessRemapMode: (mode: RemapMode) => void;
  wearRemapMode: RemapMode;
  onSelectWearRemapMode: (mode: RemapMode) => void;
  glowCapable: boolean;
  glowEnabled: boolean;
  onToggleGlow: () => void;
  bandMode: BandMode;
  onSelectBandMode: (mode: BandMode) => void;
  bands: BandTuning;
  onUpdateBands: (patch: Partial<BandTuning>) => void;
  onResetBands: () => void;
}

const btnStyle = (active: boolean) => ({
  fontSize: 11,
  padding: "4px 8px",
  borderColor: active ? "var(--d2-cyan)" : undefined,
  color: active ? "var(--d2-cyan)" : undefined,
});

export default function GearDebugControls({
  debugChannel,
  onSelectDebugChannel,
  toneMapping,
  onSelectToneMapping,
  roughnessRemapMode,
  onSelectRoughnessRemapMode,
  wearRemapMode,
  onSelectWearRemapMode,
  glowCapable,
  glowEnabled,
  onToggleGlow,
  bandMode,
  onSelectBandMode,
  bands,
  onUpdateBands,
  onResetBands,
}: GearDebugControlsProps) {
  const toneNote = TONE_MAPPING_OPTIONS.find((o) => o.key === toneMapping)?.note;

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
          TONE MAPPING
        </label>
        <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
          Applies to the whole render, not just the gear. ACES is React Three
          Fiber&apos;s default rather than a choice anyone made here, and every
          material tuned by eye was tuned against it — so A/B this while
          re-tuning. The gearstack channels below always force this off, so
          their readings stay raw whatever is picked here.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {TONE_MAPPING_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              className="d2-btn"
              style={btnStyle(toneMapping === opt.key)}
              title={opt.note}
              onClick={() => onSelectToneMapping(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {toneNote && (
          <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 6, lineHeight: 1.5 }}>
            {toneNote}
          </p>
        )}
      </div>

      <div>
        <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
          GEARSTACK CHANNEL
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {GEARSTACK_CHANNELS.map((label, ch) => (
            <button
              key={label}
              className="d2-btn"
              style={btnStyle(debugChannel === ch)}
              onClick={() => onSelectDebugChannel(ch as GearstackDebugChannel)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
          ROUGHNESS REMAP INTERPRETATION
        </label>
        <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
          Authored mode applies each material&apos;s bias, scale, lower bound and
          range width. The legacy modes are retained for comparison only.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {REMAP_MODES.map((label, mode) => (
            <button
              key={label}
              className="d2-btn"
              style={btnStyle(roughnessRemapMode === mode)}
              onClick={() => onSelectRoughnessRemapMode(mode as RemapMode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
          WEAR REMAP INTERPRETATION
        </label>
        <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
          Authored mode treats the remapped value as surviving coating: one
          preserves the original finish, zero reveals the worn material.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {REMAP_MODES.map((label, mode) => (
            <button
              key={label}
              className="d2-btn"
              style={btnStyle(wearRemapMode === mode)}
              onClick={() => onSelectWearRemapMode(mode as RemapMode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {glowCapable && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
            GLOW ANIMATION
          </label>
          <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
            Detected on this item&apos;s own mesh (some stage parts carry a flag
            marking them as extra ability-VFX geometry — flame-shaped protrusions
            that don&apos;t exist in the item&apos;s default in-game render, e.g. Thy
            Fearful Symmetry&apos;s brow/temple/jaw). Off by default to match that;
            toggling on reveals them with a fire-style gradient + flicker instead
            of flat, always-on geometry.
          </p>
          <button
            className="d2-btn"
            style={{ ...btnStyle(glowEnabled), marginTop: 6 }}
            onClick={onToggleGlow}
          >
            {glowEnabled ? "Glow: ON" : "Glow: OFF"}
          </button>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: "var(--d2-text-dim)" }}>
          SINGLE-SLOT BAND DECODE
        </label>
        <p style={{ fontSize: 10, color: "var(--d2-text-faint)", marginTop: 4, lineHeight: 1.5 }}>
          Authored material slots are the default. The other modes are legacy
          experiments on eligible meshes: gearstack alpha encodes wear, not six
          material IDs. They are not faithful material decoders.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {BAND_MODES.map((label, mode) => (
            <button
              key={label}
              className="d2-btn"
              style={btnStyle(bandMode === mode)}
              onClick={() => onSelectBandMode(mode as BandMode)}
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
            onClick={onResetBands}
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
              disabled={bandMode !== 0}
              min={0}
              max={1}
              step={0.005}
              value={bands[key]}
              onChange={(e) => onUpdateBands({ [key]: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span className="mono" style={{ fontSize: 11, color: "var(--d2-cyan)", width: 44 }}>
              {bands[key].toFixed(3)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export { BAND_DEFAULTS };

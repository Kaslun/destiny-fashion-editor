"use client";

/**
 * The overview list: every armor slot on one line — equipped piece, the shader
 * applied to it, and the two set-wide actions (strip the set back to default,
 * or push one shader across all five pieces).
 *
 * It doubles as navigation: any cell on a row opens that slot in the browse
 * column, on the layer (ornament / shader) that was clicked.
 */
import type { SlotKey } from "@/components/viewer/CharacterModel";
import { tierColor, type ItemEntry } from "./ItemBrowser";
import { ARMOR_SLOTS, type Layer } from "./slots";

interface Props {
  items: Partial<Record<SlotKey, ItemEntry>>;
  shaders: Partial<Record<SlotKey, ItemEntry>>;
  onEdit: (slot: SlotKey, layer: Layer) => void;
  /** Clear every ornament + shader back to the class's default set. */
  onResetAll: () => void;
  /** Open the shader browser in "apply to every slot" mode. */
  onShadeAll: () => void;
  shadeAllArmed: boolean;
}

const TILE = 84;

/** A 32px icon chip + label, used for both the shader and the piece column. */
function Chip({
  item,
  fallback,
  border,
  onClick,
}: {
  item: ItemEntry | null;
  fallback: string;
  border: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        minWidth: 0,
        padding: 0,
        background: "none",
        border: "none",
        cursor: "pointer",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
      }}
    >
      <span
        style={{
          position: "relative",
          width: 32,
          height: 32,
          flexShrink: 0,
          background: "rgba(255,255,255,0.12)",
          border: `1px solid ${border}`,
          overflow: "hidden",
        }}
      >
        {item?.icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.icon}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
      </span>
      <span
        style={{
          fontSize: 17,
          lineHeight: 1.3,
          letterSpacing: "0.01em",
          color: item ? "var(--fx-ink)" : "var(--fx-ink-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item?.name ?? fallback}
      </span>
    </button>
  );
}

export default function OverviewPanel({
  items,
  shaders,
  onEdit,
  onResetAll,
  onShadeAll,
  shadeAllArmed,
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 26,
          paddingBottom: 22,
          marginLeft: 72,
        }}
      >
        <button
          className="fx-tile"
          title="Reset every slot to its default appearance"
          onClick={onResetAll}
          style={{
            width: TILE,
            height: TILE,
            display: "grid",
            placeItems: "center",
            background: "rgba(255,255,255,0.10)",
            borderColor: "var(--fx-line-strong)",
          }}
        >
          <span
            style={{
              width: 26,
              height: 31,
              background: "rgba(255,255,255,0.82)",
              clipPath: "polygon(0 0,100% 0,100% 62%,50% 100%,0 62%)",
            }}
          />
        </button>
        <button
          className="fx-tile"
          data-selected={shadeAllArmed}
          title="Apply one shader to all armor"
          onClick={onShadeAll}
          style={{
            width: TILE,
            height: TILE,
            background:
              "repeating-linear-gradient(135deg, rgba(240,210,100,0.34) 0 5px, rgba(240,210,100,0.12) 5px 10px)",
            borderColor: "var(--fx-line-strong)",
          }}
        />
      </div>

      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: `22px 26px ${TILE}px 46px minmax(180px, 260px) minmax(0, 1fr)`,
          alignItems: "center",
          gap: "18px 12px",
        }}
      >
        {/* Spine linking the rows, stopping short of the last one */}
        <div
          style={{
            position: "absolute",
            left: 34,
            top: 0,
            bottom: 42,
            width: 1,
            background: "var(--fx-line-strong)",
          }}
        />

        {ARMOR_SLOTS.map((slot) => {
          const item = items[slot.key] ?? null;
          const shader = shaders[slot.key] ?? null;
          const border = item ? tierColor(item.tier) : "var(--fx-line-strong)";
          return (
            <div key={slot.key} style={{ display: "contents" }}>
              <span style={{ fontSize: 14, color: "var(--fx-ink-dim)", textAlign: "center" }}>
                {slot.glyph}
              </span>
              <div style={{ height: 1, background: "var(--fx-line-strong)" }} />
              <button
                className="fx-tile"
                title={`Edit ${slot.label}`}
                onClick={() => onEdit(slot.key, "gear")}
                style={{
                  width: TILE,
                  height: TILE,
                  borderColor: border,
                  overflow: "hidden",
                }}
              >
                <span className="fx-tile__fill" />
                {item?.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.icon} alt="" />
                )}
              </button>
              <div style={{ height: 1, background: "var(--fx-line-strong)" }} />
              <Chip
                item={shader}
                fallback="Default Shader"
                border="rgba(255,255,255,0.4)"
                onClick={() => onEdit(slot.key, "shader")}
              />
              <Chip
                item={item}
                fallback={slot.label}
                border={border}
                onClick={() => onEdit(slot.key, "gear")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

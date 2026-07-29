"use client";

/**
 * The vertical slot rail: overview on top, then one tile per armor slot showing
 * what's equipped there. This is the editor's primary navigation — picking a
 * tile points the browse column (and the camera) at that piece.
 */
import type { SlotKey, PieceStatus } from "@/components/viewer/CharacterModel";
import { tierColor, type ItemEntry } from "./ItemBrowser";
import { ARMOR_SLOTS, type Focus } from "./slots";

interface Props {
  focus: Focus;
  onFocus: (focus: Focus) => void;
  items: Partial<Record<SlotKey, ItemEntry>>;
  status: Partial<Record<SlotKey, PieceStatus>>;
}

const TILE = 74;

export default function SlotRail({ focus, onFocus, items, status }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, flexShrink: 0 }}>
      <button
        className="fx-tile"
        data-selected={focus === "overview"}
        title="All armor"
        onClick={() => onFocus("overview")}
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
            width: 24,
            height: 28,
            background: "rgba(255,255,255,0.82)",
            clipPath: "polygon(0 0,100% 0,100% 62%,50% 100%,0 62%)",
          }}
        />
      </button>

      <div style={{ height: 6 }} />

      {ARMOR_SLOTS.map((slot) => {
        const item = items[slot.key] ?? null;
        const st = status[slot.key];
        return (
          <button
            key={slot.key}
            className="fx-tile"
            data-selected={focus === slot.key}
            title={item ? `${slot.label} — ${item.name}` : slot.label}
            onClick={() => onFocus(slot.key)}
            style={{ width: TILE, height: TILE, overflow: "hidden" }}
          >
            <span className="fx-tile__fill" />
            {item?.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.icon} alt="" />
            )}
            {!item?.icon && (
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 16,
                  color: "var(--fx-ink-dim)",
                }}
              >
                {slot.glyph}
              </span>
            )}
            <span
              className="fx-tile__tier"
              style={{ background: item ? tierColor(item.tier) : "transparent" }}
            />
            {st === "loading" && (
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  background: "rgba(24,29,35,0.5)",
                  fontSize: 13,
                  color: "#ffffff",
                }}
              >
                …
              </span>
            )}
            {st === "error" && (
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  right: 5,
                  fontSize: 12,
                  color: "var(--fx-danger)",
                }}
                title="This piece failed to load"
              >
                !
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

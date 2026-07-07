"use client";

/**
 * Appearance Customization — full-character fashion editor.
 *
 * Mirrors Destiny 2's transmog/shader screen: a left column of the five armor
 * slots (each showing its equipped ornament + shader), the assembled 3D
 * character in the center, and a contextual browser on the right for the slot
 * being edited. Armor is class-specific, so switching class clears the set.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import ItemBrowser, { type ItemEntry } from "@/components/editor/ItemBrowser";
import ShaderPicker from "@/components/editor/ShaderPicker";
import AppHeader from "@/components/ui/AppHeader";
import type {
  SlotKey,
  EquippedPiece,
  PieceStatus,
} from "@/components/viewer/CharacterModel";

const ModelViewer = dynamic(() => import("@/components/viewer/ModelViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ padding: 24, color: "var(--d2-text-dim)" }}>Booting viewport…</div>
  ),
});
const CharacterModel = dynamic(() => import("@/components/viewer/CharacterModel"), {
  ssr: false,
});

const CLASSES = [
  { value: 0, label: "Titan" },
  { value: 1, label: "Hunter" },
  { value: 2, label: "Warlock" },
];

const ARMOR_SLOTS: { key: SlotKey; label: string; glyph: string }[] = [
  { key: "helmet", label: "Helmet", glyph: "◈" },
  { key: "gauntlets", label: "Arms", glyph: "✋" },
  { key: "chest", label: "Chest", glyph: "▣" },
  { key: "legs", label: "Legs", glyph: "⋀" },
  { key: "classItem", label: "Class Item", glyph: "✶" },
];

type BrowseMode = "gear" | "shader";
type SlotState<T> = Partial<Record<SlotKey, T>>;

interface ProfileChar {
  characterId: string;
  classType: number;
  className: string;
  emblemPath: string | null;
  light: number;
  items: {
    slot: string;
    renderHash: number;
    itemHash: number;
    shaderHash: number | null;
  }[];
}

export default function EditorPage() {
  const [classType, setClassType] = useState(1); // Hunter default
  const [items, setItems] = useState<SlotState<ItemEntry>>({});
  const [shaders, setShaders] = useState<SlotState<ItemEntry>>({});
  const [status, setStatus] = useState<SlotState<PieceStatus>>({});
  const [activeSlot, setActiveSlot] = useState<SlotKey>("helmet");
  const [mode, setMode] = useState<BrowseMode>("gear");

  // Build the CharacterModel input from equipped items + their shaders.
  const pieces = useMemo<Partial<Record<SlotKey, EquippedPiece | null>>>(() => {
    const out: Partial<Record<SlotKey, EquippedPiece | null>> = {};
    for (const { key } of ARMOR_SLOTS) {
      const item = items[key];
      out[key] = item
        ? { itemHash: item.hash, shaderHash: shaders[key]?.hash ?? null }
        : null;
    }
    return out;
  }, [items, shaders]);

  const onPieceStatus = useCallback((slot: SlotKey, s: PieceStatus) => {
    setStatus((prev) => ({ ...prev, [slot]: s }));
  }, []);

  const onPickItem = useCallback(
    (item: ItemEntry) => setItems((prev) => ({ ...prev, [activeSlot]: item })),
    [activeSlot],
  );
  const onPickShader = useCallback(
    (hash: number | null) =>
      setShaders((prev) => {
        const next = { ...prev };
        if (hash === null) delete next[activeSlot];
        // ShaderPicker only returns a hash; look it up lazily via /api later if
        // we want the icon. For now store a minimal entry so the chip renders.
        else next[activeSlot] = { ...(prev[activeSlot] as ItemEntry), hash } as ItemEntry;
        return next;
      }),
    [activeSlot],
  );

  const changeClass = useCallback((c: number) => {
    setClassType(c);
    setItems({}); // armor is class-specific — reset the set
    setShaders({});
    setStatus({});
  }, []);

  // ── Real-account loadout (Bungie OAuth) ──
  const [authState, setAuthState] = useState<"unknown" | "out" | "in">("unknown");
  const [characters, setCharacters] = useState<ProfileChar[]>([]);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/profile");
      if (res.status === 401) {
        setAuthState("out");
        setCharacters([]);
        return;
      }
      const data = await res.json();
      setAuthState("in");
      setCharacters(data.characters ?? []);
    } catch {
      setAuthState("out");
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const equipLoadout = useCallback((c: ProfileChar) => {
    setClassType(c.classType);
    const nextItems: SlotState<ItemEntry> = {};
    const nextShaders: SlotState<ItemEntry> = {};
    for (const it of c.items) {
      if (!ARMOR_SLOTS.some((s) => s.key === it.slot)) continue; // armor = the body
      nextItems[it.slot as SlotKey] = {
        hash: it.renderHash,
        name: it.slot,
        icon: null,
        slot: it.slot,
        kind: "armor",
        tier: "",
        classType: c.classType,
      };
      if (it.shaderHash) {
        nextShaders[it.slot as SlotKey] = { hash: it.shaderHash } as ItemEntry;
      }
    }
    setItems(nextItems);
    setShaders(nextShaders);
    setStatus({});
  }, []);

  const equippedCount = ARMOR_SLOTS.filter((s) => items[s.key]).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppHeader title="Appearance Customization" subtitle="Fashion · Full Character" />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* ── Left: slot column ── */}
        <aside
          style={{
            width: 340,
            borderRight: "1px solid var(--d2-line)",
            display: "flex",
            flexDirection: "column",
            padding: 16,
            gap: 12,
            overflowY: "auto",
          }}
        >
          {/* Bungie account: sign in, or pick a Guardian to load its loadout */}
          <div>
            {authState === "out" && (
              <a
                href="/api/auth/login"
                className="d2-btn d2-btn--primary"
                style={{
                  display: "block",
                  textAlign: "center",
                  padding: "9px 0",
                  fontSize: 12,
                  textDecoration: "none",
                }}
              >
                Sign in with Bungie
              </a>
            )}
            {authState === "in" && characters.length > 0 && (
              <div>
                <p className="d2-eyebrow" style={{ margin: "0 0 6px" }}>
                  Your Guardians
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {characters.map((c) => (
                    <button
                      key={c.characterId}
                      className="d2-btn"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: 6,
                        textAlign: "left",
                      }}
                      onClick={() => equipLoadout(c)}
                    >
                      {c.emblemPath && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.emblemPath}
                          alt=""
                          style={{ width: 28, height: 28, objectFit: "cover" }}
                        />
                      )}
                      <span style={{ flex: 1 }}>{c.className}</span>
                      <span style={{ color: "var(--d2-gold)", fontSize: 12 }}>
                        ✦ {c.light}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Class picker */}
          <div style={{ display: "flex", gap: 6 }}>
            {CLASSES.map((c) => (
              <button
                key={c.value}
                className={`d2-btn ${classType === c.value ? "d2-btn--primary" : ""}`}
                style={{ flex: 1, padding: "8px 0", fontSize: 12 }}
                onClick={() => changeClass(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div>
            <p className="d2-eyebrow" style={{ margin: 0 }}>
              Customization
            </p>
            <p
              style={{
                margin: "2px 0 0",
                fontSize: 11,
                color: "var(--d2-text-faint)",
                letterSpacing: "0.06em",
              }}
            >
              {equippedCount}/5 SLOTS · APPLY PER PIECE
            </p>
          </div>

          {/* Slot rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ARMOR_SLOTS.map((slot) => (
              <SlotRow
                key={slot.key}
                slot={slot}
                item={items[slot.key] ?? null}
                shader={shaders[slot.key] ?? null}
                status={status[slot.key]}
                active={activeSlot === slot.key}
                activeMode={activeSlot === slot.key ? mode : null}
                onEditItem={() => {
                  setActiveSlot(slot.key);
                  setMode("gear");
                }}
                onEditShader={() => {
                  setActiveSlot(slot.key);
                  setMode("shader");
                }}
              />
            ))}
          </div>
        </aside>

        {/* ── Center: 3D character ── */}
        <section style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div className="d2-frame" />
          <ModelViewer>
            <CharacterModel pieces={pieces} onPieceStatus={onPieceStatus} />
          </ModelViewer>
          {equippedCount === 0 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                color: "var(--d2-text-faint)",
                textAlign: "center",
              }}
            >
              <div>
                <p className="d2-eyebrow">Full Character</p>
                <p>Equip armor to each slot to assemble your Guardian.</p>
              </div>
            </div>
          )}
        </section>

        {/* ── Right: contextual browser ── */}
        <aside
          style={{
            width: 360,
            borderLeft: "1px solid var(--d2-line)",
            display: "flex",
            flexDirection: "column",
            padding: 16,
            minHeight: 0,
          }}
        >
          <div style={{ marginBottom: 10 }}>
            <p className="d2-eyebrow" style={{ margin: 0 }}>
              Editing
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 15, fontWeight: 600 }}>
              {ARMOR_SLOTS.find((s) => s.key === activeSlot)?.label} ·{" "}
              <span style={{ color: "var(--d2-cyan)" }}>
                {mode === "gear" ? "Ornament" : "Shader"}
              </span>
            </p>
          </div>

          {/* Gear / Shader toggle */}
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button
              className={`d2-btn ${mode === "gear" ? "d2-btn--primary" : ""}`}
              style={{ flex: 1, padding: "7px 0", fontSize: 12 }}
              onClick={() => setMode("gear")}
            >
              Ornament
            </button>
            <button
              className={`d2-btn ${mode === "shader" ? "d2-btn--primary" : ""}`}
              style={{ flex: 1, padding: "7px 0", fontSize: 12 }}
              onClick={() => setMode("shader")}
              disabled={!items[activeSlot]}
              title={items[activeSlot] ? "" : "Equip an item first"}
            >
              Shader
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0 }}>
            {mode === "gear" ? (
              <ItemBrowser
                selectedHash={items[activeSlot]?.hash ?? null}
                onSelect={onPickItem}
                fixedSlot={activeSlot}
                fixedClassType={classType}
              />
            ) : (
              <ShaderPicker
                selectedShaderHash={shaders[activeSlot]?.hash ?? null}
                onSelect={onPickShader}
              />
            )}
          </div>
        </aside>
      </div>
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

function SlotRow({
  slot,
  item,
  shader,
  status,
  active,
  activeMode,
  onEditItem,
  onEditShader,
}: {
  slot: { key: SlotKey; label: string; glyph: string };
  item: ItemEntry | null;
  shader: ItemEntry | null;
  status?: PieceStatus;
  active: boolean;
  activeMode: BrowseMode | null;
  onEditItem: () => void;
  onEditShader: () => void;
}) {
  const tier = item ? (TIER_COLOR[item.tier] ?? "var(--d2-line)") : "var(--d2-line)";
  return (
    <div
      className="d2-panel"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 8,
        background: active ? "rgba(79,208,224,0.06)" : "rgba(10,12,15,0.6)",
        borderColor: active ? "var(--d2-cyan)" : "var(--d2-line)",
      }}
    >
      <div
        style={{
          width: 22,
          textAlign: "center",
          color: "var(--d2-text-dim)",
          fontSize: 14,
        }}
        title={slot.label}
      >
        {slot.glyph}
      </div>

      {/* Ornament cell */}
      <Cell
        icon={item?.icon ?? null}
        fallback={slot.label.slice(0, 4)}
        border={active && activeMode === "gear" ? "var(--d2-cyan)" : tier}
        onClick={onEditItem}
        status={status}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: item ? "var(--d2-text)" : "var(--d2-text-faint)",
          }}
        >
          {item?.name ?? slot.label}
        </div>
        <div style={{ fontSize: 10, color: "var(--d2-text-faint)" }}>
          {shader ? "◆ shaded" : "no shader"}
        </div>
      </div>

      {/* Shader cell */}
      <Cell
        icon={shader?.icon ?? null}
        fallback="◆"
        border={active && activeMode === "shader" ? "var(--d2-cyan)" : "var(--d2-line)"}
        onClick={onEditShader}
        disabled={!item}
      />
    </div>
  );
}

function Cell({
  icon,
  fallback,
  border,
  onClick,
  status,
  disabled,
}: {
  icon: string | null;
  fallback: string;
  border: string;
  onClick: () => void;
  status?: PieceStatus;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 44,
        height: 44,
        flexShrink: 0,
        padding: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        background: "var(--d2-bg)",
        border: `2px solid ${border}`,
        position: "relative",
        overflow: "hidden",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span style={{ fontSize: 9, color: "var(--d2-text-faint)" }}>{fallback}</span>
      )}
      {status === "loading" && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            color: "var(--d2-cyan)",
          }}
        >
          …
        </span>
      )}
      {status === "error" && (
        <span
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            fontSize: 9,
            color: "var(--d2-danger)",
            background: "rgba(0,0,0,0.7)",
            padding: "0 2px",
          }}
        >
          !
        </span>
      )}
    </button>
  );
}

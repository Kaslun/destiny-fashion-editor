"use client";

/**
 * Full-stage screens the editor puts in front of the viewport: the opening
 * assembly progress, the account gate, the Guardian roster, and the renderer
 * crash fallback. They share one look — a lit backdrop with a single column of
 * centred, tracked type — so moving between them reads as one screen changing
 * state rather than four different pages.
 */
import type { PieceStatus } from "@/components/viewer/CharacterModel";

const EYEBROW: React.CSSProperties = {
  margin: 0,
  textTransform: "uppercase",
  letterSpacing: "0.34em",
  fontWeight: 500,
  fontSize: 11,
  color: "rgba(255,255,255,0.75)",
};

const TITLE: React.CSSProperties = {
  margin: "12px 0 0",
  textTransform: "uppercase",
  fontWeight: 700,
  letterSpacing: "-0.015em",
  lineHeight: 0.95,
};

/** Opening assembly: one tile per equipped piece, lit as the piece lands. */
export function LoadingScreen({
  pieces,
  onReload,
}: {
  pieces: { label: string; status?: PieceStatus }[];
  onReload: () => void;
}) {
  const settled = pieces.filter((p) => p.status === "ready" || p.status === "error").length;
  const pct = pieces.length ? Math.round((settled / pieces.length) * 100) : 0;
  return (
    <div className="fx-overlay" style={{ gap: 26 }}>
      <p style={EYEBROW}>Assembling</p>
      <h1 style={{ ...TITLE, fontSize: 64 }}>Your Guardian</h1>
      <div style={{ width: "min(620px, 80vw)" }}>
        <div
          style={{
            position: "relative",
            height: 3,
            background: "rgba(255,255,255,0.22)",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${pct}%`,
              background: "#ffffff",
              transition: "width 0.3s",
            }}
          />
          <span className="fx-sweep" />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
          {pieces.map((p) => {
            const done = p.status === "ready";
            const failed = p.status === "error";
            const active = p.status === "loading";
            return (
              <div
                key={p.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 44,
                    height: 44,
                    background: done
                      ? "repeating-linear-gradient(135deg, rgba(244,240,230,0.3) 0 5px, rgba(244,240,230,0.1) 5px 10px)"
                      : active
                        ? "repeating-linear-gradient(135deg, rgba(236,241,245,0.16) 0 5px, rgba(236,241,245,0.05) 5px 10px)"
                        : "transparent",
                    border: `1px solid ${
                      failed
                        ? "var(--fx-danger)"
                        : done
                          ? "#ffffff"
                          : active
                            ? "rgba(255,255,255,0.4)"
                            : "rgba(255,255,255,0.24)"
                    }`,
                  }}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: failed
                      ? "var(--fx-danger)"
                      : done
                        ? "#ffffff"
                        : "rgba(255,255,255,0.55)",
                  }}
                >
                  {failed ? "failed" : done ? "ready" : active ? "loading…" : "queued"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mono" style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
        {settled} / {pieces.length} pieces
      </p>
      <button className="fx-btn" onClick={onReload}>
        ⟳ Reload viewport
      </button>
    </div>
  );
}

/** Account gate — sign in for the real loadout, or build from the catalog. */
export function SignInScreen({ onManual }: { onManual: () => void }) {
  return (
    <div className="fx-overlay">
      <div className="fx-card">
        <p style={EYEBROW}>Account</p>
        <h1 style={{ ...TITLE, fontSize: 44 }}>Sign in</h1>
        <p
          style={{
            margin: "16px 0 28px",
            fontSize: 15,
            lineHeight: 1.55,
            color: "rgba(255,255,255,0.78)",
          }}
        >
          Pull your live loadout, or skip and build a set from the full catalog.
        </p>
        <a
          href="/api/auth/login"
          className="fx-btn fx-btn--solid"
          style={{ display: "block", padding: "14px 0" }}
        >
          Sign in with Bungie
        </a>
        <button
          className="fx-btn"
          onClick={onManual}
          style={{ width: "100%", marginTop: 10, padding: "14px 0" }}
        >
          Continue in manual mode
        </button>
      </div>
    </div>
  );
}

export interface RosterCharacter {
  characterId: string;
  className: string;
  light: number;
  emblemPath: string | null;
  slots: number;
}

/** Which Guardian's loadout to dress. */
export function RosterScreen({
  characters,
  onPick,
  onSkip,
}: {
  characters: RosterCharacter[];
  onPick: (characterId: string) => void;
  onSkip: () => void;
}) {
  return (
    <div className="fx-overlay" style={{ gap: 30 }}>
      <div style={{ textAlign: "center" }}>
        <p style={EYEBROW}>Choose a Guardian</p>
        <h1 style={{ ...TITLE, fontSize: 48 }}>Your Roster</h1>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center" }}>
        {characters.map((c) => (
          <button
            key={c.characterId}
            onClick={() => onPick(c.characterId)}
            className="fx-tile"
            style={{ width: 300, textAlign: "left", background: "rgba(255,255,255,0.06)" }}
          >
            <span
              style={{
                display: "block",
                height: 120,
                background: c.emblemPath
                  ? `center/cover no-repeat url(${c.emblemPath})`
                  : "repeating-linear-gradient(135deg, rgba(236,241,245,0.2) 0 6px, rgba(236,241,245,0.06) 6px 12px)",
              }}
            />
            <span style={{ display: "block", padding: "16px 18px" }}>
              <span
                style={{
                  display: "block",
                  textTransform: "uppercase",
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                  fontSize: 22,
                }}
              >
                {c.className}
              </span>
              <span
                style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}
              >
                <span style={{ color: "var(--fx-gold)", fontSize: 12 }}>✦</span>
                <span
                  style={{ fontWeight: 700, fontSize: 19, fontVariantNumeric: "tabular-nums" }}
                >
                  {c.light}
                </span>
                <span
                  style={{
                    textTransform: "uppercase",
                    letterSpacing: "0.16em",
                    fontSize: 10,
                    color: "rgba(255,255,255,0.6)",
                    marginLeft: "auto",
                  }}
                >
                  {c.slots} slots
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <button className="fx-btn" onClick={onSkip}>
        Build from the catalog instead
      </button>
    </div>
  );
}

/** The renderer died (usually a lost WebGPU device) — remount and reload. */
export function CrashScreen({
  detail,
  onRelaunch,
}: {
  detail?: string;
  onRelaunch: () => void;
}) {
  return (
    <div className="fx-overlay fx-overlay--crash">
      <div className="fx-card" style={{ width: 540, borderColor: "rgba(242,131,107,0.6)" }}>
        <p style={{ ...EYEBROW, color: "var(--fx-danger)" }}>Viewport crashed</p>
        <h1 style={{ ...TITLE, fontSize: 40 }}>Renderer stopped</h1>
        <p
          style={{
            margin: "16px 0 8px",
            fontSize: 15,
            lineHeight: 1.55,
            color: "rgba(255,255,255,0.78)",
          }}
        >
          Your set is intact — relaunching rebuilds the canvas and reloads every piece.
        </p>
        <p
          className="mono"
          style={{
            margin: "0 0 28px",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            wordBreak: "break-word",
          }}
        >
          {detail ?? "unknown error"}
        </p>
        <button
          className="fx-btn fx-btn--solid"
          onClick={onRelaunch}
          style={{ width: "100%", padding: "14px 0" }}
        >
          ⟳ Relaunch viewport
        </button>
      </div>
    </div>
  );
}

/** Nothing equipped — the stage stands empty. */
export function EmptyStage() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <div>
        <div
          style={{
            width: 74,
            height: 74,
            margin: "0 auto 20px",
            border: "1px solid rgba(93,106,118,0.6)",
            transform: "rotate(45deg)",
          }}
        />
        <p style={{ ...EYEBROW, color: "#4e5b67" }}>Nothing equipped</p>
        <p style={{ margin: "14px 0 0", fontSize: 16, color: "#4e5b67" }}>
          Pick a slot on the left to start building.
        </p>
      </div>
    </div>
  );
}

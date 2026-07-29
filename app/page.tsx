import Link from "next/link";

/**
 * Landing screen. Same stage language as the editor — a lit backdrop, one
 * oversized tracked headline, and the two ways in (straight to the editor, or
 * sign in first to pull a real loadout).
 */
const STATS = [
  { value: "5", label: "Armor slots" },
  { value: "WebGPU", label: "Node materials" },
  { value: "TGXM", label: "Real gear geometry" },
];

export default function Home() {
  return (
    <div
      className="fx-root"
      style={{
        background: "linear-gradient(100deg, #39434d 0%, #4e5a67 42%, #8492a0 100%)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 clamp(24px, 6vw, 120px)",
        overflowY: "auto",
      }}
    >
      <p
        style={{
          margin: 0,
          textTransform: "uppercase",
          letterSpacing: "0.34em",
          fontWeight: 500,
          fontSize: 12,
          color: "rgba(255,255,255,0.8)",
        }}
      >
        Destiny Fashion Editor
      </p>
      <h1
        style={{
          margin: "20px 0 0",
          textTransform: "uppercase",
          fontWeight: 700,
          letterSpacing: "-0.015em",
          fontSize: "clamp(48px, 7vw, 104px)",
          lineHeight: 0.9,
          maxWidth: 1100,
        }}
      >
        Your Guardian,
        <br />
        rendered in full
      </h1>
      <p
        style={{
          margin: "26px 0 0",
          fontSize: 19,
          lineHeight: 1.5,
          color: "rgba(255,255,255,0.8)",
          maxWidth: 620,
        }}
      >
        Real gear geometry, real shaders, real dyes — assembled in the browser from
        Bungie&apos;s own asset pipeline.
      </p>

      <div style={{ display: "flex", gap: 12, marginTop: 40, flexWrap: "wrap" }}>
        <Link
          href="/editor"
          className="fx-btn fx-btn--solid"
          style={{ padding: "17px 34px", fontSize: 13 }}
        >
          Open the editor
        </Link>
        <a href="/api/auth/login" className="fx-btn" style={{ padding: "17px 34px", fontSize: 13 }}>
          Sign in with Bungie
        </a>
        <Link href="/poc" className="fx-btn" style={{ padding: "17px 34px", fontSize: 13 }}>
          POC viewer
        </Link>
      </div>

      <div
        style={{
          display: "flex",
          gap: 56,
          marginTop: 76,
          paddingTop: 26,
          borderTop: "1px solid rgba(255,255,255,0.24)",
          maxWidth: 900,
          flexWrap: "wrap",
        }}
      >
        {STATS.map((s) => (
          <div key={s.label}>
            <div
              style={{ fontWeight: 700, fontSize: 34, fontVariantNumeric: "tabular-nums" }}
            >
              {s.value}
            </div>
            <div
              style={{
                marginTop: 4,
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                fontSize: 10,
                color: "rgba(255,255,255,0.65)",
              }}
            >
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

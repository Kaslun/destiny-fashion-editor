import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";

export default function Home() {
  return (
    <>
    <AppHeader title="Destiny Fashion" subtitle="3D Editor" />
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "56px 24px" }}>
      <p className="d2-eyebrow">Bungie API · Three.js · Gear Assets</p>
      <h1 style={{ fontSize: 56, lineHeight: 1.0, marginTop: 8 }}>
        Destiny Fashion Editor
      </h1>
      <hr className="d2-rule" style={{ maxWidth: 320 }} />
      <p style={{ color: "var(--d2-text-dim)", maxWidth: 620, lineHeight: 1.6 }}>
        A web-based 3D character &amp; fashion tool. Render your real gear with
        equipped armor, weapons and shaders — or build a look from scratch.
      </p>

      <div className="d2-panel" style={{ padding: 24, marginTop: 32, maxWidth: 620 }}>
        <p className="d2-eyebrow">Build status — Step 1</p>
        <h2 style={{ fontSize: 24, marginTop: 6 }}>Gear Asset Proof-of-Concept</h2>
        <p style={{ color: "var(--d2-text-dim)", lineHeight: 1.6 }}>
          The renderer pipeline (manifest → gear-asset SQLite → TGXM geometry →
          Three.js) is wired to a verification page. Load a single item hash and
          confirm the real LOD-0 mesh and textures render.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <Link href="/editor" className="d2-btn d2-btn--primary" style={{ display: "inline-block" }}>
            Open Manual Editor →
          </Link>
          <Link href="/poc" className="d2-btn" style={{ display: "inline-block" }}>
            POC Viewer
          </Link>
        </div>
      </div>
    </main>
    </>
  );
}

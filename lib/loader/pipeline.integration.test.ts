/**
 * Integration test against the running dev server (localhost:3000).
 * Proves the REAL gear-asset pipeline end-to-end: resolve an item hash, fetch
 * its proxied .tgxm geometry, parse the container, and build Three.js geometry
 * with actual triangles.
 *
 * Run with the dev server up:  npx vitest run lib/loader/pipeline.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import { parseTgxm } from "../geometry/tgxm";
import { buildGeometryFromContainer } from "../geometry/buildGeometry";
import { summarize } from "../geometry/renderMetadata";

const BASE = "http://localhost:3000";
const GJALLARHORN = 1363886209;

describe("real gear-asset pipeline", () => {
  it("resolves, parses and builds geometry for a real item", async () => {
    const res = await fetch(`${BASE}/api/gearasset/${GJALLARHORN}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.found).toBe(true);

    const content = data.content.find((c: any) => c.geometry.length > 0);
    expect(content).toBeTruthy();

    let totalMeshes = 0;
    let totalTriangles = 0;

    for (const geom of content.geometry) {
      const buf = await fetch(`${BASE}${geom.proxyUrl}`).then((r) => {
        expect(r.ok).toBe(true);
        return r.arrayBuffer();
      });
      const container = parseTgxm(buf);
      expect(container.files.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        `\n[${geom.file}] v${container.version} files:`,
        container.files.map((f) => `${f.name}(${f.size})`).join(", "),
      );

      const built = buildGeometryFromContainer(container);
      const s = summarize(built.metadata) as { meshes: { lodCategories: number[] }[] };
      // eslint-disable-next-line no-console
      console.log(
        `  -> ${built.meshes.length} mesh(es), lodCategories`,
        JSON.stringify(s.meshes.map((m) => m.lodCategories)),
      );

      for (const m of built.meshes) {
        totalMeshes++;
        const idx = m.geometry.getIndex();
        if (idx) totalTriangles += idx.count / 3;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Built ${totalMeshes} meshes, ${totalTriangles} triangles`);
    expect(totalMeshes).toBeGreaterThan(0);
    expect(totalTriangles).toBeGreaterThan(0);
  }, 60000);
});

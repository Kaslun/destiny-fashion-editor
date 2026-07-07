/**
 * GET /api/gearasset/:hash
 *
 * Resolves an item hash to its gear-asset content (geometry / texture / gear
 * file references) plus the CDN base paths, and rewrites every referenced file
 * into a proxied `/api/asset?path=...` URL the browser can fetch without hitting
 * CORS (#250).
 *
 * Query params:
 *   ?raw=1   also include the raw SQLite record (for empirical field discovery).
 */
import { NextRequest, NextResponse } from "next/server";
import { getGearAsset, hashToSignedId } from "@/lib/bungie/gearAsset";
import { getItemGear } from "@/lib/bungie/gearDyeData";
import { getManifest, cdnUrl } from "@/lib/bungie/manifest";
import { apiError } from "@/lib/http";

export const runtime = "nodejs"; // needs fs + sql.js wasm
// Cold starts download + open a large gear-asset SQLite DB — allow headroom.
export const maxDuration = 60;

function proxied(cdnPath: string): string {
  return `/api/asset?path=${encodeURIComponent(cdnPath)}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  const itemHash = Number(hash);
  if (!Number.isFinite(itemHash)) {
    return NextResponse.json({ error: "Invalid item hash" }, { status: 400 });
  }

  try {
    const [manifest, gearAsset] = await Promise.all([
      getManifest(),
      getGearAsset(itemHash),
    ]);

    if (!gearAsset) {
      return NextResponse.json(
        { error: "No gear asset for this hash", itemHash, found: false },
        { status: 404 },
      );
    }

    const cdn = manifest.gearCdn;

    // Map every referenced file to an absolute CDN path + a proxied URL.
    const resolved = gearAsset.content.map((c) => ({
      platform: c.platform ?? null,
      geometry: (c.geometry ?? []).map((f) => ({
        file: f,
        cdnPath: cdnUrl(cdn.Geometry, f),
        proxyUrl: proxied(cdnUrl(cdn.Geometry, f)),
      })),
      textures: (c.textures ?? []).map((f) => ({
        file: f,
        cdnPath: cdnUrl(cdn.Texture, f),
        proxyUrl: proxied(cdnUrl(cdn.Texture, f)),
      })),
      gear: (c.gear ?? []).map((f) => ({
        file: f,
        cdnPath: cdnUrl(cdn.Gear, f),
        proxyUrl: proxied(cdnUrl(cdn.Gear, f)),
      })),
      dye_index_set: c.dye_index_set ?? null,
      region_index_sets: c.region_index_sets ?? null,
    }));

    const wantRaw = req.nextUrl.searchParams.get("raw") === "1";

    // Determine which geometry to render. Region-mapped items (weapons) draw
    // all geometry; body-arrangement items (armor) list base + gender/class
    // overrides — render only the base so the variants don't overlap.
    const hasRegions = resolved.some(
      (c) => c.region_index_sets && Object.keys(c.region_index_sets).length > 0,
    );
    const gear = await getItemGear(itemHash);
    const renderGeometryIndices =
      !hasRegions && gear.baseGeometryCount != null
        ? Array.from({ length: gear.baseGeometryCount }, (_, i) => i)
        : null; // null = render all geometry

    return NextResponse.json({
      itemHash,
      signedId: hashToSignedId(itemHash),
      found: true,
      manifestVersion: manifest.version,
      gearCdn: cdn,
      content: resolved,
      renderGeometryIndices,
      ...(wantRaw ? { raw: gearAsset.raw } : {}),
    });
  } catch (err) {
    return apiError(err, 500, "gearasset");
  }
}

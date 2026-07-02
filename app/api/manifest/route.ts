/**
 * GET /api/manifest — returns the trimmed, cached manifest (version, gear-asset
 * DB list, CDN base paths). Handy for confirming credentials work and for
 * inspecting the live `mobileGearCDN` shape. `?force=1` bypasses the cache.
 */
import { NextRequest, NextResponse } from "next/server";
import { getManifest } from "@/lib/bungie/manifest";
import { apiError, isProd } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // `force` re-downloads the manifest from Bungie — only honoured in dev to
    // avoid a resource-abuse vector in production.
    const force = !isProd() && req.nextUrl.searchParams.get("force") === "1";
    const manifest = await getManifest(force);
    return NextResponse.json(manifest);
  } catch (err) {
    return apiError(err, 500, "manifest");
  }
}

/**
 * GET /api/manifest — returns the trimmed, cached manifest (version, gear-asset
 * DB list, CDN base paths). Handy for confirming credentials work and for
 * inspecting the live `mobileGearCDN` shape. `?force=1` bypasses the cache.
 */
import { NextRequest, NextResponse } from "next/server";
import { getManifest } from "@/lib/bungie/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get("force") === "1";
    const manifest = await getManifest(force);
    return NextResponse.json(manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

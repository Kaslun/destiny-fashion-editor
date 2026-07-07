/**
 * GET /api/dyes/:hash — dye colours (per slot) for a shader/dye item hash.
 * Empty object for items without a gear file.
 */
import { NextRequest, NextResponse } from "next/server";
import { getGearDyes, getItemGear } from "@/lib/bungie/gearDyeData";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  const n = Number(hash);
  if (!Number.isFinite(n)) {
    return NextResponse.json({ error: "Invalid hash" }, { status: 400 });
  }
  try {
    if (_req.nextUrl.searchParams.has("debug")) {
      const gear = await getItemGear(n);
      return NextResponse.json({ hash: n, rawDefaultDyes: gear.rawDefaultDyes });
    }
    const dyes = await getGearDyes(n);
    return NextResponse.json({ hash: n, slots: dyes });
  } catch (err) {
    return apiError(err, 500, "dyes");
  }
}
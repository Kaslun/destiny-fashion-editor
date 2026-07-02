/**
 * Debug: GET /api/debug/gearsql               -> gear-asset DB tables + counts
 *        GET /api/debug/gearsql?table=X&hash=N -> one row from table X by hash
 * Used to reverse-engineer where dye material properties live.
 */
import { NextRequest, NextResponse } from "next/server";
import { listGearDbTables, queryGearTable } from "@/lib/bungie/gearAsset";
import { apiError, isProd } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Introspection endpoint — never exposed in production.
  if (isProd()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const table = req.nextUrl.searchParams.get("table");
  const hash = req.nextUrl.searchParams.get("hash");
  try {
    if (table && hash) {
      const row = await queryGearTable(table, Number(hash));
      return NextResponse.json({ table, hash: Number(hash), row });
    }
    return NextResponse.json(await listGearDbTables());
  } catch (err) {
    return apiError(err, 500, "debug/gearsql");
  }
}

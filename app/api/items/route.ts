/**
 * GET /api/items?q=&slot=&kind=&classType=&limit=
 * Search the trimmed item index (weapons + armor) for the manual-mode browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { searchItems, type SlotKey } from "@/lib/bungie/itemDefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLOTS = new Set<SlotKey>([
  "kinetic",
  "energy",
  "power",
  "helmet",
  "gauntlets",
  "chest",
  "legs",
  "classItem",
]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const slotParam = sp.get("slot") as SlotKey | null;
    const kindParam = sp.get("kind");
    const classParam = sp.get("classType");

    const result = await searchItems({
      q: sp.get("q") ?? undefined,
      slot: slotParam && SLOTS.has(slotParam) ? slotParam : undefined,
      kind:
        kindParam === "weapon" || kindParam === "armor" ? kindParam : undefined,
      classType: classParam != null ? Number(classParam) : undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

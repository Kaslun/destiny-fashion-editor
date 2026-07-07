/**
 * GET /api/items?q=&slot=&kind=&classType=&limit=
 * Search the trimmed item index (weapons + armor) for the manual-mode browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { searchItems, getItemByHash, type SlotKey } from "@/lib/bungie/itemDefs";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// First call downloads + trims the ~tens-of-MB item definitions table.
export const maxDuration = 60;

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
    // Exact lookup by hash (used to show a rendered item's name from its hash).
    const hashParam = sp.get("hash");
    if (hashParam) {
      const item = await getItemByHash(Number(hashParam));
      return NextResponse.json({ item });
    }

    const slotParam = sp.get("slot") as SlotKey | null;
    const kindParam = sp.get("kind");
    const classParam = sp.get("classType");

    const result = await searchItems({
      q: sp.get("q") ?? undefined,
      slot: slotParam && SLOTS.has(slotParam) ? slotParam : undefined,
      kind:
        kindParam === "weapon" || kindParam === "armor" || kindParam === "shader"
          ? kindParam
          : undefined,
      classType: classParam != null ? Number(classParam) : undefined,
      tier: sp.get("tier") ?? undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, "items");
  }
}

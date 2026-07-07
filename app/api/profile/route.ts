/**
 * GET /api/profile — the signed-in user's characters + equipped loadouts.
 * 401 when not logged in. Renders the applied ornament geometry per slot;
 * shader resolution (applied dyes) is layered on separately.
 */
import { NextRequest, NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/currentSession";
import { getCharacterLoadouts } from "@/lib/bungie/profile";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const active = await getActiveSession(req);
  if (!active) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  try {
    const characters = await getCharacterLoadouts(active.accessToken);
    const res = NextResponse.json({
      characters: characters.map((c) => ({
        characterId: c.characterId,
        classType: c.classType,
        className: c.className,
        emblemPath: c.emblemPath ? `/api/asset?path=${encodeURIComponent(c.emblemPath)}` : null,
        light: c.light,
        items: c.items.map((it) => ({
          slot: it.slot,
          // render the applied ornament (transmog) when present, else the base item.
          renderHash: it.ornamentHash ?? it.itemHash,
          itemHash: it.itemHash,
          ornamentHash: it.ornamentHash,
          shaderHash: null as number | null, // resolved in a later pass
          plugHashes: it.plugHashes,
        })),
      })),
    });
    active.applyCookie(res);
    return res;
  } catch (err) {
    return apiError(err, 500, "profile");
  }
}

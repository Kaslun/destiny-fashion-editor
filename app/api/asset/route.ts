/**
 * GET /api/asset?path=/common/destiny2_content/...
 *
 * Server-side proxy for bungie.net CDN assets (geometry .tgxm, textures
 * .tgxm.bin, gear .js, images). Browsers can't fetch these directly because of
 * same-origin / CORS restrictions (Bungie-net/api #250); routing through our own
 * origin sidesteps it and lets us attach the X-API-Key.
 *
 * Only bungie.net paths are allowed — this is a scoped proxy, not an open one.
 */
import { NextRequest, NextResponse } from "next/server";
import { bungieFetchRaw } from "@/lib/bungie/client";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("path");
  if (!raw) {
    return NextResponse.json({ error: "Missing ?path" }, { status: 400 });
  }

  // Accept either a bungie.net path or a full bungie.net URL; reject anything else.
  let targetPath: string;
  if (raw.startsWith("http")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    if (url.hostname !== "www.bungie.net" && url.hostname !== "bungie.net") {
      return NextResponse.json(
        { error: "Only bungie.net assets may be proxied" },
        { status: 403 },
      );
    }
    targetPath = url.pathname + url.search;
  } else if (raw.startsWith("/common/") || raw.startsWith("/Platform/")) {
    targetPath = raw;
  } else {
    return NextResponse.json(
      { error: "Path must be a bungie.net /common/ asset path" },
      { status: 403 },
    );
  }

  const upstream = await bungieFetchRaw(targetPath);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream ${upstream.status} for ${targetPath}` },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  // Pick a sensible content-type; default to octet-stream for .tgxm binaries.
  const ext = targetPath.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const typeByExt: Record<string, string> = {
    tgxm: "application/octet-stream",
    bin: "application/octet-stream",
    js: "application/javascript",
    json: "application/json",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
  };
  const contentType =
    upstream.headers.get("content-type") ??
    typeByExt[ext] ??
    "application/octet-stream";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      // Assets are content-addressed by filename hash — cache aggressively.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export const dynamic = "force-dynamic";

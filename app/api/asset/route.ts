/** Proxy only supported Bungie static assets; never relay active site content. */
import { NextRequest, NextResponse } from "next/server";
import { bungieFetchRaw } from "@/lib/bungie/client";
import { assetTarget, safeAssetContent } from "@/lib/bungie/assetPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("path");
  if (!raw) return NextResponse.json({ error: "Missing ?path" }, { status: 400 });
  let target: ReturnType<typeof assetTarget>;
  try { target = assetTarget(raw); }
  catch { return NextResponse.json({ error: "Unsupported Bungie asset URL" }, { status: 403 }); }

  try {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]);
    let cacheControl = target.cacheControl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const upstream = await bungieFetchRaw(target.url, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = upstream.headers.get("location");
        await upstream.body?.cancel();
        if (!location || redirects === 3) throw new Error("Invalid asset redirect");
        target = assetTarget(new URL(location, target.url).href);
        // A redirecting asset identity is not necessarily content-addressed.
        cacheControl = "public, max-age=300";
        continue;
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        return NextResponse.json({ error: "Asset unavailable" }, { status: upstream.status === 404 ? 404 : 502 });
      }
      if (!safeAssetContent(target.contentType, upstream.headers.get("content-type"))) {
        await upstream.body.cancel();
        throw new Error("Unexpected asset content");
      }
      return new NextResponse(upstream.body, { status: 200, headers: {
        "Content-Type": target.contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": cacheControl,
      } });
    }
  } catch {
    return NextResponse.json({ error: "Asset service unavailable" }, { status: 502 });
  }
  return NextResponse.json({ error: "Asset service unavailable" }, { status: 502 });
}

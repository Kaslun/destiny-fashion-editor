/**
 * GET /api/auth/callback — Bungie OAuth redirect target. Validates the CSRF
 * state, exchanges the code for tokens, stores them in a signed session cookie,
 * and returns the user to the editor.
 */
import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/auth/oauth";
import {
  encodeSession,
  sessionCookieOptions,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
} from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const savedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/editor?auth=error&reason=${reason}`, req.url));

  if (!code || !state || !savedState || state !== savedState) {
    return fail("state");
  }

  try {
    const session = await exchangeCode(code);
    const res = NextResponse.redirect(new URL("/editor?auth=ok", req.url));
    res.cookies.set(SESSION_COOKIE, encodeSession(session), sessionCookieOptions());
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  } catch {
    return fail("token");
  }
}

/**
 * GET /api/auth/login — start Bungie OAuth. Sets a CSRF `state` cookie and
 * redirects the user to Bungie's consent page.
 */
import { NextResponse } from "next/server";
import crypto from "crypto";
import { authorizeUrl } from "@/lib/auth/oauth";
import { OAUTH_STATE_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}

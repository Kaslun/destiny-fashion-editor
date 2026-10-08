/** POST /api/auth/logout — clear the session cookie. */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessions } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const id = req.cookies.get(SESSION_COOKIE)?.value;
  if (id) await sessions().revoke(id);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

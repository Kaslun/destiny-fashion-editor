/** Resolve opaque sessions; persist refreshes before dependent API work. */
import type { NextRequest } from "next/server";
import { sessions, SESSION_COOKIE } from "./session";
import { refreshTokens } from "./oauth";
import { SessionRefresher } from "./refreshSession";

let refresher: SessionRefresher | undefined;
export async function getActiveSession(req: NextRequest) {
  const id = req.cookies.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  refresher ??= new SessionRefresher(sessions(), refreshTokens);
  return refresher.get(id);
}

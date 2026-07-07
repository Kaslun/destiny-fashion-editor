/**
 * Read the session from a request and return a valid access token, transparently
 * refreshing it when the access token has expired but the refresh token is still
 * good. If the token was refreshed, `applyCookie` writes the new session onto the
 * outgoing response so the browser stays logged in.
 */
import type { NextRequest, NextResponse } from "next/server";
import {
  decodeSession,
  encodeSession,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "./session";
import { refreshTokens } from "./oauth";

export interface ActiveSession {
  accessToken: string;
  bungieMembershipId: string;
  /** Call on the response to persist a refreshed session (no-op if unchanged). */
  applyCookie: (res: NextResponse) => void;
}

export async function getActiveSession(
  req: NextRequest,
): Promise<ActiveSession | null> {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;

  const now = Date.now();
  if (now < session.accessExpiresAt - 30_000) {
    return {
      accessToken: session.accessToken,
      bungieMembershipId: session.bungieMembershipId,
      applyCookie: () => {},
    };
  }

  // Access token expired — refresh if the refresh token is still valid.
  if (session.refreshToken && now < session.refreshExpiresAt) {
    try {
      const fresh = await refreshTokens(session.refreshToken);
      if (!fresh.bungieMembershipId) fresh.bungieMembershipId = session.bungieMembershipId;
      return {
        accessToken: fresh.accessToken,
        bungieMembershipId: fresh.bungieMembershipId,
        applyCookie: (res) =>
          res.cookies.set(SESSION_COOKIE, encodeSession(fresh), sessionCookieOptions()),
      };
    } catch {
      return null;
    }
  }

  return null;
}

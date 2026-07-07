/**
 * Stateless signed session for Bungie OAuth tokens.
 *
 * The session is stored in an httpOnly cookie as `base64url(payload).hmac` so it
 * can't be read or tampered with client-side. Access/refresh tokens never reach
 * the browser — API routes read the session server-side and attach the bearer
 * token to Bungie calls. SECURITY: signed (HMAC-SHA256) but NOT encrypted, so
 * only store what the server needs; the tokens are opaque to Bungie anyway.
 */
import crypto from "crypto";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "d2session";
export const OAUTH_STATE_COOKIE = "d2oauth_state";

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  accessExpiresAt: number;
  /** epoch ms when the refresh token expires */
  refreshExpiresAt: number;
  /** bungie.net membership id from the token response */
  bungieMembershipId: string;
}

function sign(payloadB64: string): string {
  return crypto
    .createHmac("sha256", env.sessionSecret())
    .update(payloadB64)
    .digest("base64url");
}

export function encodeSession(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined | null): SessionData | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionData;
  } catch {
    return null;
  }
}

/** Cookie options for the session cookie. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90, // 90 days (refresh-token lifetime)
  };
}

/**
 * Bungie OAuth token exchange + refresh.
 *
 * Bungie is a *confidential* OAuth client (we have a client secret), so the
 * token endpoint is authenticated with HTTP Basic (client_id:client_secret).
 * Docs: https://github.com/Bungie-net/api/wiki/OAuth-Documentation
 */
import { env } from "@/lib/env";
import { BUNGIE_PLATFORM } from "@/lib/bungie/client";
import type { SessionData } from "./session";

const TOKEN_URL = `${BUNGIE_PLATFORM}/App/OAuth/Token/`;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  membership_id: string;
}

function basicAuth(): string {
  const raw = `${env.oauthClientId()}:${env.oauthClientSecret()}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function tokenRequest(body: URLSearchParams): Promise<SessionData> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(),
      "X-API-Key": env.bungieApiKey(),
    },
    body,
  });
  const text = await res.text();
  let tok: Partial<TokenResponse>;
  try {
    tok = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON (${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok || !tok.access_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${(tok as { error_description?: string }).error_description ?? text.slice(0, 160)}`,
    );
  }
  const now = Date.now();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? "",
    accessExpiresAt: now + (tok.expires_in ?? 3600) * 1000,
    refreshExpiresAt: now + (tok.refresh_expires_in ?? 7776000) * 1000,
    bungieMembershipId: tok.membership_id ?? "",
  };
}

/** Exchange an authorization code for tokens (OAuth callback). */
export function exchangeCode(code: string): Promise<SessionData> {
  return tokenRequest(
    new URLSearchParams({ grant_type: "authorization_code", code }),
  );
}

/** Refresh an expired access token using the refresh token. */
export function refreshTokens(refreshToken: string): Promise<SessionData> {
  return tokenRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}

/** The Bungie authorize URL to redirect the user to for sign-in. */
export function authorizeUrl(state: string): string {
  const url = new URL("https://www.bungie.net/en/OAuth/Authorize");
  url.searchParams.set("client_id", env.oauthClientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Thin wrapper around the Bungie.net Platform API.
 *
 * Every request needs the `X-API-Key` header. Authenticated (OAuth) calls also
 * need a bearer token — added later in build step #2. All responses come back
 * wrapped in a standard envelope:
 *
 *   { Response, ErrorCode, ThrottleSeconds, ErrorStatus, Message, MessageData }
 *
 * ErrorCode === 1 (Success) is the only non-error code.
 */

import { env } from "@/lib/env";

export const BUNGIE_ROOT = "https://www.bungie.net";
export const BUNGIE_PLATFORM = `${BUNGIE_ROOT}/Platform`;

export class BungieApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: number,
    readonly status: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "BungieApiError";
  }
}

interface BungieEnvelope<T> {
  Response: T;
  ErrorCode: number;
  ThrottleSeconds: number;
  ErrorStatus: string;
  Message: string;
  MessageData: Record<string, string>;
}

function apiKey(): string {
  return env.bungieApiKey();
}

/**
 * Call a Bungie Platform endpoint and unwrap the `Response` field.
 * `path` may be an absolute URL or a path relative to the Platform root.
 */
export async function bungieFetch<T>(
  path: string,
  init: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BUNGIE_PLATFORM}${path}`;
  const { accessToken, ...rest } = init;

  const headers = new Headers(rest.headers);
  headers.set("X-API-Key", apiKey());
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(url, { ...rest, headers });
  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    // Bungie occasionally returns HTML error pages (rate limit / maintenance).
    const text = await res.text();
    throw new BungieApiError(
      `Non-JSON response from Bungie (${res.status}): ${text.slice(0, 200)}`,
      -1,
      "NonJsonResponse",
      res.status,
    );
  }

  const body = (await res.json()) as BungieEnvelope<T>;
  if (body.ErrorCode !== 1) {
    throw new BungieApiError(
      body.Message || "Bungie API error",
      body.ErrorCode,
      body.ErrorStatus,
      res.status,
    );
  }
  return body.Response;
}

/**
 * Fetch a raw (non-Platform) asset/CDN file from bungie.net as bytes.
 * Used server-side to proxy geometry/texture files around browser CORS (#250).
 */
export async function bungieFetchRaw(path: string): Promise<Response> {
  const url = path.startsWith("http") ? path : `${BUNGIE_ROOT}${path}`;
  return fetch(url, { headers: { "X-API-Key": apiKey() } });
}

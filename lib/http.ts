/**
 * Shared helpers for API route error handling.
 *
 * Detailed error messages can leak internal paths/state, so we log the real
 * error server-side and return a generic message to clients in production while
 * keeping details in development for debugging.
 */
import { NextResponse } from "next/server";

export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/** JSON error response: logs server-side, hides details in production. */
export function apiError(
  err: unknown,
  status = 500,
  context?: string,
): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  // Server-side log (full detail) regardless of environment.
  console.error(`[api]${context ? ` ${context}:` : ""}`, message);
  return NextResponse.json(
    { error: isProd() ? "Internal error" : message },
    { status },
  );
}

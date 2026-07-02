/**
 * Centralized, server-only environment access.
 *
 * SECURITY: none of these may be read client-side. They are intentionally NOT
 * prefixed with NEXT_PUBLIC_, so Next will never bundle them into client code.
 * Import this only from server modules (API routes, server components, lib code
 * that runs on the server). Each getter validates lazily and fails fast with a
 * clear message rather than sending undefined credentials to Bungie.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name} (see .env.example).`);
  }
  return v;
}

export const env = {
  bungieApiKey: () => required("BUNGIE_API_KEY"),
  // OAuth values are only required once logged-in mode is implemented.
  oauthClientId: () => required("BUNGIE_OAUTH_CLIENT_ID"),
  oauthClientSecret: () => required("BUNGIE_OAUTH_CLIENT_SECRET"),
  redirectUrl: () =>
    process.env.BUNGIE_REDIRECT_URL ?? "http://localhost:3000/api/auth/callback",
  sessionSecret: () => required("SESSION_SECRET"),
};

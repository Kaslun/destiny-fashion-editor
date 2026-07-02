# Security Model & Practices

This document is the source of truth for how the Destiny Fashion Editor handles
secrets, external requests, and untrusted input. Read it before adding an API
route, touching auth, or changing the asset proxy.

## Threat model (what we protect)
- **Bungie API key** (`BUNGIE_API_KEY`) — grants API access under our app
  registration; must never reach the browser.
- **OAuth client secret + user tokens** (once logged-in mode lands) — grant
  access to a user's Bungie account.
- **Our origin** — must not become an open proxy or SSRF pivot.

## Secrets
- All secrets live in `.env.local` (git-ignored via `.env*.local`). `.env.example`
  documents the shape with empty values and is the only env file committed.
- Access secrets **only** through `lib/env.ts`. Never read `process.env.SECRET`
  directly in feature code, and never prefix a secret with `NEXT_PUBLIC_`
  (that bundles it into client JS).
- `lib/env.ts` getters fail fast with a clear message if a required var is
  missing — surface config errors at the boundary, not as `undefined` sent to
  Bungie.
- Server-only modules (`lib/bungie/*`, `lib/env.ts`, API routes) must never be
  imported into client components.

## External requests
- Outbound calls to Bungie go through `lib/bungie/client.ts`
  (`bungieFetch` / `bungieFetchRaw`), which attaches `X-API-Key` server-side.
- **Asset proxy (`/api/asset`)** is a *scoped* proxy, not an open one: it only
  forwards `bungie.net` hosts and `/common/` or `/Platform/` paths. Do not relax
  this allowlist — an open proxy is an SSRF and abuse vector. Responses are
  cached `immutable` because asset filenames are content-hashed.

## Untrusted input
- Validate/parse every request param. Numeric hashes: `Number()` + `isFinite`.
  Enumerated values (slot, kind): check against an allowlist.
- **Never interpolate request input into SQL/identifiers.** Values bind as
  parameters; table/column names (which can't bind) must be validated against a
  strict identifier regex **and** an existence check (see
  `queryGearTable` in `lib/bungie/gearAsset.ts`).

## Error handling
- API routes return errors via `apiError()` (`lib/http.ts`): full detail is
  logged server-side; clients get a generic message in production. Don't echo
  raw `err.message` (leaks internal paths/state).

## Debug / introspection endpoints
- Anything under `/api/debug/*`, and expensive/mutating actions like the manifest
  `?force=1` re-download, are gated behind `!isProd()` (`lib/http.ts`). Never
  ship an introspection or cache-busting endpoint reachable in production.

## HTTP headers
- Baseline headers are set in `next.config.mjs` (`nosniff`, `SAMEORIGIN`,
  `Referrer-Policy`, `Permissions-Policy`).
- **TODO (before public deploy):** add a Content-Security-Policy. It's deferred
  because it needs per-env tuning — Next dev needs `'unsafe-eval'`, the WebGL
  viewer uses `blob:` images and canvas. Target prod policy:
  `default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`.

## OAuth (build step 2 — NOT yet implemented; follow this when adding it)
- Use Authorization Code flow **with PKCE**.
- Generate a random `state` per request, store it in an httpOnly cookie, and
  verify it on callback (CSRF defense).
- Store the session in an **httpOnly, Secure, SameSite=Lax** cookie. Never put
  tokens in `localStorage` or expose them to client JS.
- Encrypt the refresh token at rest (key from `SESSION_SECRET`); store server-side.
- Exchange/refresh tokens only server-side, through `lib/bungie/client.ts`.

## Deployment checklist (before going public)
- [ ] Set all env vars in the host's secret store (not committed).
- [ ] Add the CSP header (see above).
- [ ] Add rate limiting to `/api/*` (proxy + search are abusable) — e.g. per-IP.
- [ ] Confirm `NODE_ENV=production` so debug routes 404 and errors are generic.
- [ ] Restrict CORS/origin on the Bungie app registration to the deployed origin.

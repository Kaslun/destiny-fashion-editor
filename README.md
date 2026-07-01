# Destiny Fashion Editor

Web-based 3D Destiny 2 character & fashion editor. Renders real equipped gear
(armor, weapons, shaders) in the browser using Bungie's mobile gear-asset
pipeline, with a manual "build from scratch" mode and Bungie OAuth for pulling a
live loadout.

## Status — Build Step 1 complete (real gear-asset renderer)

The gear-asset pipeline is proven end-to-end against live Bungie data: an item
hash resolves to real `.tgxm` geometry which parses and renders in Three.js
(verified with Gjallarhorn → 3 meshes / ~158k triangles). **Path taken: real
gear assets**, not the stylized proxy fallback.

Still to come (steps 2–5): textures/gearstack shading (geometry currently renders
untextured), Bungie OAuth + token storage, manifest ingestion to a database, the
manual-mode editor UI, and logged-in mode via `GetProfile`.

## Stack
Next.js (App Router, TS) · React Three Fiber / Three.js · Zustand · sql.js ·
fflate. Backend is **required** (not optional) — see Architecture.

## Setup
1. Register an app at <https://www.bungie.net/en/Application>.
2. Copy `.env.example` → `.env.local` and fill in `BUNGIE_API_KEY` (OAuth fields
   are only needed for logged-in mode, build step 2).
3. `npm install`
4. `npm run dev` → open <http://localhost:3000/poc>, enter an item hash, **Load**.
   - Confirm credentials at <http://localhost:3000/api/manifest>.

## Architecture (why a backend is mandatory)
- `mobileGearAssetDataBases` are **ZIP-wrapped SQLite** files (not JSON) —
  downloaded, unzipped, and queried by item hash server-side.
- Direct `.tgxm` fetches from bungie.net hit CORS
  ([Bungie-net/api#250](https://github.com/Bungie-net/api/issues/250)) — proxied
  through our own origin.

Pipeline: `/api/gearasset/[hash]` (resolve) → browser fetches proxied `.tgxm`
via `/api/asset` → `lib/geometry/tgxm.ts` (container) → `renderMetadata.ts`
(LOD/vertex layout) → `buildGeometry.ts` (BufferGeometry) → `lib/materials/`
(dye / gearstack) → `components/viewer/` (R3F canvas).

## Key paths
| Path | Role |
|------|------|
| `lib/bungie/` | API client, manifest, gear-asset SQLite resolver |
| `app/api/gearasset/[hash]`, `app/api/asset` | resolver + CDN proxy |
| `lib/geometry/` | TGXM container + render_metadata + geometry builder |
| `lib/materials/` | dye resolution + gearstack material |
| `components/viewer/` | R3F `ModelViewer` + `GearModel` (with fallback) |
| `app/poc/page.tsx` | step-1 verification harness |

## Tests
```
npm test                                              # unit (offline)
npx vitest run lib/loader/pipeline.integration.test.ts  # needs dev server up
```

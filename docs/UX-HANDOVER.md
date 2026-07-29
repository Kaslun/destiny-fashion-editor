# Technical Handover — UI/UX Revamp

Purpose: give a UX/UI designer the technical facts needed to redesign this app's interface. This document is deliberately design-agnostic — it describes what exists and how it's built, not what it should look like.

## 1. Stack

- **Framework**: Next.js 15 (App Router), React 19, TypeScript 5.8
- **3D rendering**: Three.js 0.185 via `three/webgpu` + `@react-three/fiber` 9 + `@react-three/drei` 10
- **State**: local React state (`useState`/`useMemo`/`useCallback`) per component; `zustand` is a dependency but not currently wired into the UI components below (no global store in use in the reviewed screens)
- **Validation**: `zod`
- **Testing**: `vitest` (unit tests only, no UI/component or e2e tests currently)
- **No CSS framework** — no Tailwind, no CSS-in-JS library, no component library (no MUI/Radix/shadcn). No design tokens file beyond the CSS custom properties described below.
- **No global font/asset build step** — fonts are referenced by CSS `font-family` stacks with system fallbacks only; no `next/font` usage found.

## 2. Routing / pages

Three routes exist under `app/`:

| Route | File | Purpose |
|---|---|---|
| `/` | [app/page.tsx](../app/page.tsx) | Static landing page, links to the other two |
| `/editor` | [app/editor/page.tsx](../app/editor/page.tsx) | **Main product screen** — full-character loadout editor |
| `/poc` | [app/poc/page.tsx](../app/poc/page.tsx) | Internal single-item render proof-of-concept / debug tool, not user-facing product |

`/editor` is the screen that matters for a redesign; `/poc` is a developer debug page and likely out of scope.

## 3. `/editor` screen structure

`app/editor/page.tsx` is a single ~680-line client component (`"use client"`) that owns almost all editor state and renders a fixed 3-column layout via plain `flex` (no CSS grid layout system, no responsive breakpoints defined for this screen — see §7):

- **Left column** (fixed 340px): account sign-in / character-loadout picker, class selector (3 buttons), and 5 armor-slot rows (helmet/arms/chest/legs/class item), each row showing an ornament thumbnail + shader thumbnail + status.
- **Center**: the 3D viewport (`ModelViewer` + `CharacterModel`), with an always-mounted corner-frame overlay div, a manual "reload viewport" button, and conditional full-screen overlays for the loading state and empty state.
- **Right column** (fixed 360px): a 3-tab panel (Ornament / Shader / Debug) that swaps between `ItemBrowser`, `ShaderPicker`, and `GearDebugControls`.

All layout and visual styling in this file is **inline `style={{...}}` objects**, not CSS classes, except where it references the shared `.d2-*` utility classes from `app/globals.css`. There is no component-level CSS module or styled-components — a redesign will likely touch both the JSX layout and `app/globals.css` together.

## 4. Component inventory

| Component | File | Responsibility | Notes for a redesign |
|---|---|---|---|
| `AppHeader` | [components/ui/AppHeader.tsx](../components/ui/AppHeader.tsx) | Top bar: avatar swatch, title/subtitle, 3-link nav (Home/Editor/POC) using `next/navigation` `usePathname` for active state | Shared across all 3 pages |
| `ItemBrowser` | [components/editor/ItemBrowser.tsx](../components/editor/ItemBrowser.tsx) | Slot/class/rarity filter controls + search input (debounced 220ms) + sort dropdown, wraps `PaginatedIconGrid` | Fetches `/api/items` on every filter change; has its own loading/error/empty states |
| `PaginatedIconGrid` | [components/editor/PaginatedIconGrid.tsx](../components/editor/PaginatedIconGrid.tsx) | Generic responsive grid: measures its container with `ResizeObserver` and computes whole columns × whole rows that fit (no partial rows, no scrolling within the grid) — pagination controls instead of infinite scroll | Reusable, not layout-specific; page size is a function of pixel measurements at runtime, not a fixed count |
| `itemSort.ts` | [components/editor/itemSort.ts](../components/editor/itemSort.ts) | Pure sort-comparator module, no UI | — |
| `ShaderPicker` | [components/editor/ShaderPicker.tsx](../components/editor/ShaderPicker.tsx) | Shader (color-scheme) selection list for the active slot | Not read in full during this audit — same data-fetch-driven pattern as `ItemBrowser` |
| `GearDebugControls` | [components/editor/GearDebugControls.tsx](../components/editor/GearDebugControls.tsx) | Internal shader-tuning dev panel (channel isolation, remap modes, band thresholds, glow toggle) | Developer/QA tool, not a customer-facing feature — confirm with product owner whether it belongs in a redesigned customer UI at all |
| `ModelViewer` | [components/viewer/ModelViewer.tsx](../components/viewer/ModelViewer.tsx) | Owns the `@react-three/fiber` `<Canvas>`, WebGPU renderer lifecycle, lighting rig, environment map, orbit controls | See §6 for hard constraints |
| `CharacterModel` | [components/viewer/CharacterModel.tsx](../components/viewer/CharacterModel.tsx) | Loads and assembles the 5 equipped armor pieces into one rigged character inside the canvas; reports per-slot status (`loading`/`ready`/`error`) back to the page | Async, per-piece; drives the loading-screen logic in `page.tsx` |
| `ViewportBoundary` | [components/viewer/ViewportBoundary.tsx](../components/viewer/ViewportBoundary.tsx) | React error boundary around the canvas; a caught error swaps in a fallback UI with a manual reload button | Exists because WebGPU device-loss/shader-compile failures throw *inside* the render loop and would otherwise blank the whole page silently |

## 5. State & data flow (on `/editor`)

- All state (equipped items per slot, shaders per slot, per-slot load status, active slot, active right-panel tab, auth state, character list, debug-shader tuning values, a `booted` flag, a `viewportKey` remount counter) lives in `useState` hooks in `app/editor/page.tsx` and is threaded down as props. There is no context provider and no zustand store wired up here — a redesign that restructures the layout (e.g., moving panels, collapsing columns) will need to either keep this prop-drilling pattern or introduce real state management.
- Data fetching is plain `fetch()` calls to internal API routes (`/api/items`, `/api/profile`, `/api/dyes/[hash]`, `/api/gearasset/[hash]`, `/api/asset`), no React Query/SWR — so there's no shared cache, request de-duping, or stale-while-revalidate; every filter change in `ItemBrowser` re-fetches from scratch (debounced).
- Icon/asset images are proxied through `/api/asset` (server-side proxy for Bungie CDN URLs) and rendered as plain `<img>` tags with `loading="lazy"` in the grid.

## 6. 3D viewport — hard technical constraints

These are not stylistic choices; they constrain what a redesign can assume about the center viewport:

- **Requires `three/webgpu`'s `WebGPURenderer`**, not the standard WebGL renderer, because the gear material system is built on Three's Node/TSL shader system. The code comment in `ModelViewer.tsx` states classic GLSL `ShaderMaterial`s (e.g. drei's `<Grid>`) are *not* compatible and had to be swapped for built-in materials.
- Renderer instantiation is async (`renderer.init()`) and is deliberately cached per-`<canvas>` in a `WeakMap` on `globalThis` to survive React StrictMode double-mounting and Fast Refresh — a full remount (new React `key`) is the supported way to reset a broken canvas, and `page.tsx` already exposes a manual "reload viewport" affordance for this reason. Any redesign of loading/error states should preserve a visible reload action.
- A full 5-piece character load takes roughly **15–25 seconds** cold (10–25 sequential texture fetches across pieces), per prior project notes — the UI currently blocks behind a loading overlay until all slots settle (`ready` or `error`) rather than progressively revealing pieces. A redesign has room to make this progressive, but should account for that real latency.
- Per-slot status is tri-state: `loading | ready | error` (see `PieceStatus` type in `CharacterModel.tsx`), already surfaced in the left column's slot rows and available to design against.

## 7. Responsive behavior — current state

- Only `/poc`'s layout and the shared `.editor-aside`/`.poc-aside` classes have a defined breakpoint: `@media (max-width: 760px)` in `app/globals.css`, which stacks the viewport above the side panel and makes the aside full-width.
- **`/editor`'s three-column layout (`app/editor/page.tsx`) has no responsive breakpoints at all** — the 340px/flex/360px columns are fixed inline styles with no mobile or narrow-viewport handling. This is a gap a redesign will need to address explicitly, not an existing pattern to preserve.
- No responsive images/`srcset`, no container queries in use anywhere.

## 8. Styling mechanism (not the current visual style)

- Global tokens and reusable classes live in one file: [app/globals.css](../app/globals.css) (custom properties under `:root`, plus utility classes prefixed `d2-*` for panels, buttons, inputs, tabs, headers).
- Individual components mix these shared classes with large amounts of **per-element inline `style` objects** written directly in JSX — there is no consistent single source of truth for spacing/sizing per component, and no shared spacing scale beyond a couple of CSS custom properties.
- No CSS reset beyond a minimal `* { box-sizing: border-box }` and body margin/background rules.
- No dark/light theme switching logic exists — colors are hardcoded CSS custom property values, single theme only.
- No icon system/library — UI glyphs in `app/editor/page.tsx` (e.g. slot icons) are literal Unicode characters in the JSX (`◈`, `✋`, `▣`, `⋀`, `✶`), not an icon font or SVG component set.

## 9. Auth-dependent UI states

`/editor`'s left column branches on an `authState` of `"unknown" | "out" | "in"` (from `/api/profile`, Bungie OAuth-backed):
- `out`: shows a "Sign in with Bungie" link/button
- `in` with characters: shows a clickable list of the account's Guardians (avatar + name + power level) that, on click, replaces the whole equipped set
- A user can also skip auth entirely and use the app in "manual mode," picking arbitrary items via `ItemBrowser` regardless of auth state — auth only pre-fills a loadout, it doesn't gate the editor.

## 10. Known technical gaps relevant to a redesign

- No component library/design-system tooling exists to build on — a redesign implemented in code will be starting from inline styles + one global CSS file, not refactoring an existing token/component system.
- No accessibility affordances observed in the reviewed files (no `aria-label`s beyond one `aria-hidden`, no focus-visible styling, no keyboard-nav handling beyond native button/input semantics, color-only status indicators in places like tier borders).
- `GearDebugControls` (the "Debug" tab) is a developer tool mixed into the same right-panel tab strip as the two customer-facing modes (Ornament, Shader) — worth flagging to product/UX whether it should be visually/structurally separated or removed from the customer surface.
- No test coverage exists for any UI component (`vitest` tests only cover geometry/material/loader logic under `lib/`) — a visual redesign has no regression safety net from the test suite and should be verified manually/visually.

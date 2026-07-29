"use client";

/**
 * Local (browser-only) editor preferences: favourited items and saved looks.
 *
 * Neither exists on Bungie's side — favourites are a browsing convenience and a
 * saved set is a look the user assembled here, so both live in localStorage
 * keyed by this app. Every read is guarded for SSR and for corrupt/foreign
 * values, since a bad parse must never take the editor down.
 */
import type { SlotKey } from "@/components/viewer/CharacterModel";
import type { ItemEntry } from "@/components/editor/ItemBrowser";

const FAVORITES_KEY = "dfe.favorites.v1";
const SETS_KEY = "dfe.savedSets.v1";

export interface SavedSet {
  id: string;
  name: string;
  classType: number;
  items: Partial<Record<SlotKey, ItemEntry>>;
  shaders: Partial<Record<SlotKey, ItemEntry>>;
  savedAt: number;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — favourites aren't worth failing a render over */
  }
}

// ── Favourites ──────────────────────────────────────────────────────────────

export function loadFavorites(): Set<number> {
  const list = read<number[]>(FAVORITES_KEY, []);
  return new Set(Array.isArray(list) ? list.filter((n) => typeof n === "number") : []);
}

export function saveFavorites(favorites: Set<number>): void {
  write(FAVORITES_KEY, [...favorites]);
}

// ── Saved sets ──────────────────────────────────────────────────────────────

export function loadSets(): SavedSet[] {
  const list = read<SavedSet[]>(SETS_KEY, []);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string") : [];
}

export function saveSets(sets: SavedSet[]): void {
  write(SETS_KEY, sets);
}

export function newSetId(): string {
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

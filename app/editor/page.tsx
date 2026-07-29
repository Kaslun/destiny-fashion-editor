"use client";

/**
 * Appearance Customization — full-character fashion editor.
 *
 * The screen is the stage: a lit studio the assembled Guardian stands in, with
 * the UI floating over the left third as white rules and tiles. Navigation is
 * the slot rail (helmet → class item) plus an overview list that shows the
 * whole set at once; picking a slot points both the browse column and the
 * camera at that piece. Armor is class-specific, so switching class resets the
 * set.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import type * as THREE from "three";
import ItemBrowser, { tierColor, type ItemEntry } from "@/components/editor/ItemBrowser";
import ShaderPicker from "@/components/editor/ShaderPicker";
import GearDebugControls from "@/components/editor/GearDebugControls";
import SlotRail from "@/components/editor/SlotRail";
import OverviewPanel from "@/components/editor/OverviewPanel";
import {
  LoadingScreen,
  SignInScreen,
  RosterScreen,
  CrashScreen,
  EmptyStage,
} from "@/components/editor/Screens";
import { ARMOR_SLOTS, SLOT_LABEL, type Focus, type Layer } from "@/components/editor/slots";
import ViewportBoundary from "@/components/viewer/ViewportBoundary";
import SlotFocusCamera from "@/components/viewer/SlotFocusCamera";
import type { LightPreset } from "@/components/viewer/ModelViewer";
import {
  DEFAULT_TONE_MAPPING,
  type ToneMappingKey,
} from "@/components/viewer/toneMapping";
import type {
  SlotKey,
  EquippedPiece,
  PieceStatus,
} from "@/components/viewer/CharacterModel";
import { helmetHidesHood } from "@/lib/bungie/hoodHiding";
import {
  loadFavorites,
  saveFavorites,
  loadSets,
  saveSets,
  newSetId,
  type SavedSet,
} from "@/lib/editor/prefs";
import {
  setGearstackDebugChannel,
  DEFAULT_ROUGHNESS_REMAP_MODE,
  DEFAULT_WEAR_REMAP_MODE,
  setRoughnessRemapMode,
  setWearRemapMode,
  BAND_DEFAULTS,
  setBandThresholds,
  DEFAULT_BAND_MODE,
  setBandMode,
  DEFAULT_GLOW_ENABLED,
  setGlowEnabled,
  hasAnimatedGlow,
  type BandMode,
  type BandTuning,
  type GearstackDebugChannel,
  type RemapMode,
} from "@/lib/materials/gearMaterial";

const ModelViewer = dynamic(() => import("@/components/viewer/ModelViewer"), {
  ssr: false,
  loading: () => null,
});
const CharacterModel = dynamic(() => import("@/components/viewer/CharacterModel"), {
  ssr: false,
});

const CLASSES = [
  { value: 0, label: "Titan" },
  { value: 1, label: "Hunter" },
  { value: 2, label: "Warlock" },
];

const LIGHTS: { value: LightPreset; label: string }[] = [
  { value: "studio", label: "Studio" },
  { value: "tower", label: "Tower" },
  { value: "night", label: "Night" },
];

/** Skipping the account gate is remembered so manual mode doesn't nag. */
const MANUAL_MODE_KEY = "dfe.manualMode.v1";

type SlotState<T> = Partial<Record<SlotKey, T>>;

/** Everything the undo stack, saved sets and Revert operate on. */
interface Look {
  classType: number;
  items: SlotState<ItemEntry>;
  shaders: SlotState<ItemEntry>;
}

const EMPTY_LOOK: Look = { classType: 1, items: {}, shaders: {} };

interface ProfileChar {
  characterId: string;
  classType: number;
  className: string;
  emblemPath: string | null;
  light: number;
  items: {
    slot: string;
    renderHash: number;
    itemHash: number;
    shaderHash: number | null;
  }[];
}

/** Look one item up by hash for its display name/icon (the index the browser uses). */
async function fetchItem(hash: number): Promise<ItemEntry | null> {
  try {
    const res = await fetch(`/api/items?hash=${hash}`);
    const data = await res.json();
    return (data.item as ItemEntry | null) ?? null;
  } catch {
    return null;
  }
}

export default function EditorPage() {
  // ── The look, and its history ──
  // Every user-facing change goes through commit() so Undo/Redo/Revert cover
  // the whole editor; async catalog fills use replace(), which doesn't create a
  // history step the user never made. lookRef mirrors state so the history can
  // be built outside a setState updater (no double-push under StrictMode).
  const [look, setLook] = useState<Look>(EMPTY_LOOK);
  const lookRef = useRef(look);
  const past = useRef<Look[]>([]);
  const future = useRef<Look[]>([]);
  /** The look Revert returns to: the pulled loadout, or the opening set. */
  const baseline = useRef<Look | null>(null);
  const [, bumpHistory] = useReducer((n: number) => n + 1, 0);

  const apply = useCallback((next: Look) => {
    lookRef.current = next;
    setLook(next);
  }, []);

  const replace = useCallback(
    (updater: (prev: Look) => Look) => apply(updater(lookRef.current)),
    [apply],
  );

  const commit = useCallback(
    (updater: (prev: Look) => Look) => {
      const prev = lookRef.current;
      const next = updater(prev);
      if (next === prev) return;
      past.current = [...past.current.slice(-49), prev];
      future.current = [];
      apply(next);
      bumpHistory();
    },
    [apply],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(lookRef.current);
    apply(prev);
    bumpHistory();
  }, [apply]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(lookRef.current);
    apply(next);
    bumpHistory();
  }, [apply]);

  const revert = useCallback(() => {
    const base = baseline.current;
    if (base) commit(() => base);
  }, [commit]);

  // ── Browse focus ──
  const [focus, setFocus] = useState<Focus>("overview");
  const [layer, setLayer] = useState<Layer>("gear");
  /** Overview → one shader across every equipped piece. */
  const [shadeAll, setShadeAll] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [status, setStatus] = useState<SlotState<PieceStatus>>({});

  // ── Stage ──
  const [light, setLight] = useState<LightPreset>("studio");
  const [menuHidden, setMenuHidden] = useState(false);
  const [devOpen, setDevOpen] = useState(false);

  // ── Local prefs ──
  const [favorites, setFavorites] = useState<Set<number>>(() => new Set());
  const [sets, setSets] = useState<SavedSet[]>([]);
  useEffect(() => {
    setFavorites(loadFavorites());
    setSets(loadSets());
  }, []);

  const toggleFavorite = useCallback((hash: number) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (!next.delete(hash)) next.add(hash);
      saveFavorites(next);
      return next;
    });
  }, []);

  // ── Debug: live shader tuning across the whole assembled character. Every
  // setting defaults to the normal in-game render, so tuning is applied
  // continuously (no on/off gate) and persists while browsing. ──
  const [debugChannel, setDebugChannelState] = useState<GearstackDebugChannel>(0);
  // Renderer-level, not per-material — handed to ModelViewer rather than pushed
  // onto the character group like the settings below.
  const [toneMapping, setToneMapping] = useState<ToneMappingKey>(DEFAULT_TONE_MAPPING);
  const [roughnessRemapMode, setRoughnessRemapModeState] = useState<RemapMode>(
    DEFAULT_ROUGHNESS_REMAP_MODE,
  );
  const [wearRemapMode, setWearRemapModeState] = useState<RemapMode>(DEFAULT_WEAR_REMAP_MODE);
  const [glowEnabled, setGlowEnabledState] = useState(DEFAULT_GLOW_ENABLED);
  const [glowCapable, setGlowCapable] = useState(false);
  const [bands, setBandsState] = useState<BandTuning>(BAND_DEFAULTS);
  const [bandMode, setBandModeState] = useState<BandMode>(DEFAULT_BAND_MODE);
  const characterRef = useRef<THREE.Group | null>(null);

  // Push every current debug selection onto a group. Called on each control
  // change (immediate feedback) and re-applied per piece as it loads, since a
  // freshly loaded piece's materials start at defaults.
  const applyDebug = useCallback(
    (group: THREE.Group) => {
      setGearstackDebugChannel(group, debugChannel);
      setRoughnessRemapMode(group, roughnessRemapMode);
      setWearRemapMode(group, wearRemapMode);
      setBandMode(group, bandMode);
      setBandThresholds(group, bands);
      setGlowEnabled(group, glowEnabled);
    },
    [debugChannel, roughnessRemapMode, wearRemapMode, bandMode, bands, glowEnabled],
  );
  // CharacterModel calls onPieceStatus from a closure captured on its last
  // effect run, so read the latest applyDebug through a ref to avoid stale
  // settings when a piece loads after a control change.
  const applyDebugRef = useRef(applyDebug);
  applyDebugRef.current = applyDebug;

  const onCharacterModel = useCallback((group: THREE.Group) => {
    characterRef.current = group;
    applyDebugRef.current(group);
  }, []);

  const selectDebugChannel = useCallback((ch: GearstackDebugChannel) => {
    setDebugChannelState(ch);
    if (characterRef.current) setGearstackDebugChannel(characterRef.current, ch);
  }, []);
  const selectRoughnessRemapMode = useCallback((m: RemapMode) => {
    setRoughnessRemapModeState(m);
    if (characterRef.current) setRoughnessRemapMode(characterRef.current, m);
  }, []);
  const selectWearRemapMode = useCallback((m: RemapMode) => {
    setWearRemapModeState(m);
    if (characterRef.current) setWearRemapMode(characterRef.current, m);
  }, []);
  const selectBandMode = useCallback((m: BandMode) => {
    setBandModeState(m);
    if (characterRef.current) setBandMode(characterRef.current, m);
  }, []);
  const updateBands = useCallback((patch: Partial<BandTuning>) => {
    setBandsState((prev) => {
      const next = { ...prev, ...patch };
      if (next.t1 > next.t2) return prev; // keep the cuts ordered
      if (characterRef.current) setBandThresholds(characterRef.current, patch);
      return next;
    });
  }, []);
  const toggleGlowEnabled = useCallback(() => {
    setGlowEnabledState((prev) => {
      const next = !prev;
      if (characterRef.current) setGlowEnabled(characterRef.current, next);
      return next;
    });
  }, []);

  // Build the CharacterModel input from equipped items + their shaders.
  const pieces = useMemo<Partial<Record<SlotKey, EquippedPiece | null>>>(() => {
    const out: Partial<Record<SlotKey, EquippedPiece | null>> = {};
    for (const { key } of ARMOR_SLOTS) {
      const item = look.items[key];
      out[key] = item
        ? { itemHash: item.hash, shaderHash: look.shaders[key]?.hash ?? null }
        : null;
    }
    // Hunter cloaks: hide the hood when the equipped helmet is on the list.
    if (out.classItem && look.classType === 1 && helmetHidesHood(look.items.helmet?.hash)) {
      out.classItem = { ...out.classItem, hideHood: true };
    }
    return out;
  }, [look]);

  // Re-frame the camera when the focused piece's geometry changes underneath it.
  const [framingRevision, setFramingRevision] = useState(0);

  const onPieceStatus = useCallback((slot: SlotKey, s: PieceStatus) => {
    setStatus((prev) => ({ ...prev, [slot]: s }));
    // A newly assembled piece starts at material defaults — re-apply the live
    // debug selections across the whole body, and refresh glow-capability from
    // the union of all equipped meshes.
    if (s === "ready" && characterRef.current) {
      applyDebugRef.current(characterRef.current);
      setGlowCapable(hasAnimatedGlow(characterRef.current));
      setFramingRevision((n) => n + 1);
    }
  }, []);

  // ── Editing actions ──
  const onPickItem = useCallback(
    (item: ItemEntry) => {
      if (focus === "overview") return;
      commit((prev) => ({ ...prev, items: { ...prev.items, [focus]: item } }));
    },
    [commit, focus],
  );

  const onPickShader = useCallback(
    (shader: ItemEntry) => {
      commit((prev) => {
        if (shadeAll) {
          const next = { ...prev.shaders };
          for (const { key } of ARMOR_SLOTS) if (prev.items[key]) next[key] = shader;
          return { ...prev, shaders: next };
        }
        if (focus === "overview") return prev;
        return { ...prev, shaders: { ...prev.shaders, [focus]: shader } };
      });
    },
    [commit, focus, shadeAll],
  );

  /** "Default" — strip the layer currently being edited on the focused slot. */
  const clearFocused = useCallback(() => {
    commit((prev) => {
      if (shadeAll) {
        const shaders = { ...prev.shaders };
        for (const { key } of ARMOR_SLOTS) delete shaders[key];
        return { ...prev, shaders };
      }
      if (focus === "overview") return prev;
      const bucket = layer === "gear" ? "items" : "shaders";
      if (!prev[bucket][focus]) return prev;
      const next = { ...prev[bucket] };
      delete next[focus];
      return { ...prev, [bucket]: next };
    });
  }, [commit, focus, layer, shadeAll]);

  /** Overview chevron — back to the set this session started from, unshaded. */
  const resetAll = useCallback(() => {
    commit((prev) => ({
      classType: prev.classType,
      items: baseline.current?.items ?? prev.items,
      shaders: {},
    }));
  }, [commit]);

  const editSlot = useCallback((slot: SlotKey, which: Layer) => {
    setShadeAll(false);
    setFocus(slot);
    setLayer(which);
  }, []);

  const onFocusRail = useCallback((next: Focus) => {
    setShadeAll(false);
    setFocus(next);
    if (next !== "overview") setLayer("gear");
  }, []);

  // Fill every empty armor slot with a data-driven placeholder (the first armor
  // piece the catalog returns for that slot + class) so the editor always shows
  // a full Guardian instead of empty slots. Only fills gaps — never clobbers an
  // already-equipped piece (e.g. a real loadout or a user pick).
  const loadDefaultSet = useCallback(
    async (cls: number) => {
      const results = await Promise.all(
        ARMOR_SLOTS.map(async ({ key }) => {
          const params = new URLSearchParams({ slot: key, kind: "armor", limit: "1" });
          if (cls !== 3) params.set("classType", String(cls));
          try {
            const res = await fetch(`/api/items?${params.toString()}`);
            const data = await res.json();
            return [key, data.items?.[0] as ItemEntry | undefined] as const;
          } catch {
            return [key, undefined] as const;
          }
        }),
      );
      replace((prev) => {
        const items = { ...prev.items };
        for (const [key, item] of results) if (item && !items[key]) items[key] = item;
        const next = { ...prev, items };
        // First complete set of the session is what Revert comes back to.
        if (!baseline.current) baseline.current = next;
        return next;
      });
    },
    [replace],
  );

  /**
   * Dev: dress every slot in a random catalog piece, each with its own random
   * shader. Sweeping the gearstack debug channels only tells you something on
   * a set you didn't hand-pick — a fixed set hides the bugs that only show up
   * on particular plate/dye data. Seeded per call and logged so a set that
   * turns up a bug can be reproduced from the console line.
   */
  const randomizeSet = useCallback(async () => {
    const cls = lookRef.current.classType;
    const pick = <T,>(arr: T[]): T | undefined =>
      arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;

    const [slotResults, shaderPool] = await Promise.all([
      Promise.all(
        ARMOR_SLOTS.map(async ({ key }) => {
          const params = new URLSearchParams({ slot: key, kind: "armor", limit: "500" });
          if (cls !== 3) params.set("classType", String(cls));
          try {
            const res = await fetch(`/api/items?${params.toString()}`);
            const data = await res.json();
            return [key, pick((data.items ?? []) as ItemEntry[])] as const;
          } catch {
            return [key, undefined] as const;
          }
        }),
      ),
      (async () => {
        try {
          const res = await fetch("/api/items?kind=shader&limit=1000");
          const data = await res.json();
          return (data.items ?? []) as ItemEntry[];
        } catch {
          return [] as ItemEntry[];
        }
      })(),
    ]);

    setStatus({});
    commit((prev) => {
      const items = { ...prev.items };
      const shaders = { ...prev.shaders };
      for (const [key, item] of slotResults) {
        if (!item) continue;
        items[key] = item;
        const shader = pick(shaderPool);
        if (shader) shaders[key] = shader;
      }
      console.log(
        "[randomize]",
        ARMOR_SLOTS.map(
          ({ key }) =>
            `${key}=${items[key]?.hash ?? "-"}/${shaders[key]?.hash ?? "-"} (${items[key]?.name ?? "-"} · ${shaders[key]?.name ?? "-"})`,
        ).join("\n"),
      );
      return { ...prev, items, shaders };
    });
  }, [commit]);

  const changeClass = useCallback(
    (c: number) => {
      // Armor is class-specific — the set can't survive the switch.
      commit(() => ({ classType: c, items: {}, shaders: {} }));
      setStatus({});
      baseline.current = null;
      loadDefaultSet(c);
    },
    [commit, loadDefaultSet],
  );

  // ── Real-account loadout (Bungie OAuth) ──
  const [authState, setAuthState] = useState<"unknown" | "out" | "in">("unknown");
  const [characters, setCharacters] = useState<ProfileChar[]>([]);
  const [gateDone, setGateDone] = useState(false);
  const [activeCharacter, setActiveCharacter] = useState<ProfileChar | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(MANUAL_MODE_KEY)) {
      setGateDone(true);
    }
    (async () => {
      try {
        const res = await fetch("/api/profile");
        if (res.status === 401) {
          setAuthState("out");
          setCharacters([]);
          return;
        }
        const data = await res.json();
        setAuthState("in");
        setCharacters(data.characters ?? []);
      } catch {
        setAuthState("out");
      }
    })();
  }, []);

  const skipAccount = useCallback(() => {
    setGateDone(true);
    try {
      window.localStorage.setItem(MANUAL_MODE_KEY, "1");
    } catch {
      /* private mode — the gate just reappears next visit */
    }
  }, []);

  // Start with a full placeholder set so the stage is never empty.
  useEffect(() => {
    loadDefaultSet(EMPTY_LOOK.classType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Dress the Guardian in a character's live loadout. The profile gives the
   * render hash (the geometry to load) and the item hash (what the player owns)
   * separately — the catalog lookup is by item hash for the name/icon, while
   * the entry keeps the render hash so the viewport loads the right mesh.
   */
  const equipLoadout = useCallback(
    async (character: ProfileChar) => {
      setActiveCharacter(character);
      setGateDone(true);
      setStatus({});
      const armor = character.items.filter((it) =>
        ARMOR_SLOTS.some((s) => s.key === it.slot),
      );
      const resolved = await Promise.all(
        armor.map(async (it) => {
          const [display, shader] = await Promise.all([
            fetchItem(it.itemHash),
            it.shaderHash ? fetchItem(it.shaderHash) : Promise.resolve(null),
          ]);
          return { it, display, shader };
        }),
      );
      const items: SlotState<ItemEntry> = {};
      const shaders: SlotState<ItemEntry> = {};
      for (const { it, display, shader } of resolved) {
        const slot = it.slot as SlotKey;
        items[slot] = {
          ...(display ?? {
            name: SLOT_LABEL[slot],
            icon: null,
            slot: it.slot,
            kind: "armor" as const,
            tier: "",
            classType: character.classType,
          }),
          hash: it.renderHash, // geometry, not the owned instance
        };
        if (it.shaderHash) {
          shaders[slot] =
            shader ??
            ({
              hash: it.shaderHash,
              name: "Shader",
              icon: null,
              slot: null,
              kind: "shader",
              tier: "",
              classType: 3,
            } as ItemEntry);
        }
      }
      const next: Look = { classType: character.classType, items, shaders };
      baseline.current = next;
      past.current = [];
      future.current = [];
      apply(next);
      bumpHistory();
      loadDefaultSet(character.classType); // fill any slots the loadout didn't cover
    },
    [apply, loadDefaultSet],
  );

  // ── Saved sets ──
  const saveCurrentSet = useCallback(() => {
    const className = CLASSES.find((c) => c.value === look.classType)?.label ?? "Guardian";
    setSets((prev) => {
      const set: SavedSet = {
        id: newSetId(),
        name: `${className} ${prev.length + 1}`,
        classType: look.classType,
        items: look.items,
        shaders: look.shaders,
        savedAt: Date.now(),
      };
      const next = [...prev, set];
      saveSets(next);
      return next;
    });
  }, [look]);

  const loadSet = useCallback(
    (set: SavedSet) => {
      setStatus({});
      commit(() => ({ classType: set.classType, items: set.items, shaders: set.shaders }));
    },
    [commit],
  );

  const deleteSet = useCallback((id: string) => {
    setSets((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSets(next);
      return next;
    });
  }, []);

  const equippedSlots = ARMOR_SLOTS.filter((s) => look.items[s.key]);
  const equippedCount = equippedSlots.length;

  // Hold the viewport behind a loading screen until the whole opening set has
  // assembled, so the user sees a complete Guardian rather than pieces popping
  // in one at a time. Latches once — later per-slot swaps don't re-trigger it.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (booted) return;
    if (equippedCount === 0) return; // placeholder set not resolved yet
    const allSettled = equippedSlots.every((s) => {
      const st = status[s.key];
      return st === "ready" || st === "error";
    });
    if (allSettled) setBooted(true);
  }, [booted, equippedCount, equippedSlots, status]);

  // The load screen covers the whole editor, so a piece that never reports
  // (a stalled fetch, a renderer that never initialized) would trap the user
  // behind it. Drop the cover after a grace period regardless — the slot rail
  // keeps showing per-piece progress from there.
  useEffect(() => {
    if (booted) return;
    const t = setTimeout(() => setBooted(true), 20_000);
    return () => clearTimeout(t);
  }, [booted]);

  // Relaunch the viewport: a new key remounts the ModelViewer (fresh WebGPU
  // canvas + renderer) and CharacterModel (reloads every piece), and clears any
  // caught render error. Used by the manual reload control and the error
  // boundary's fallback to recover from a failed/black canvas.
  const [viewportKey, setViewportKey] = useState(0);
  const reloadViewport = useCallback(() => {
    characterRef.current = null;
    setBooted(false);
    setStatus({});
    setGlowCapable(false);
    setViewportKey((k) => k + 1);
  }, []);

  // Screen-level keys, as advertised bottom-right. TAB is the game's "hide the
  // menu and look at the Guardian" — skipped while typing in the search field,
  // and Shift+Tab is left alone so keyboard focus traversal still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
      if (e.key === "Tab" && !e.shiftKey && !typing) {
        e.preventDefault();
        setMenuHidden((v) => !v);
      } else if (e.key === "Escape") {
        if (devOpen) setDevOpen(false);
        else if (menuHidden) setMenuHidden(false);
        else onFocusRail("overview");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [devOpen, menuHidden, onFocusRail]);

  const browsing = focus !== "overview" || shadeAll;
  const focusedItem = focus === "overview" ? null : (look.items[focus] ?? null);
  const focusedShader = focus === "overview" ? null : (look.shaders[focus] ?? null);
  const pickingShader = shadeAll || layer === "shader";

  const showSignIn = authState === "out" && !gateDone;
  const showRoster = authState === "in" && characters.length > 0 && !gateDone;
  const showLoading = !showSignIn && !showRoster && !booted;

  return (
    <div className="fx-root" data-light={light}>
      <div className="fx-vignette" />

      <div className="fx-shell">
        {!menuHidden && (
          <div className="fx-menu">
            {/* Title */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Link
                href="/"
                title="Home"
                style={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  border: "2px solid rgba(255,255,255,0.9)",
                  transform: "rotate(45deg)",
                }}
              />
              <h1
                style={{
                  margin: 0,
                  textTransform: "uppercase",
                  fontWeight: 500,
                  letterSpacing: "0.08em",
                  fontSize: 26,
                  textShadow: "0 1px 12px rgba(30,36,43,0.45)",
                }}
              >
                Appearance Customization
              </h1>
            </div>

            {/* Breadcrumb + rule */}
            <div style={{ marginTop: 26 }}>
              <p
                style={{
                  margin: "0 0 10px",
                  textTransform: "uppercase",
                  letterSpacing: "0.22em",
                  fontSize: 13,
                  color: "var(--fx-ink-dim)",
                  textShadow: "0 1px 8px rgba(30,36,43,0.5)",
                }}
              >
                Customization <span style={{ color: "var(--fx-ink-faint)" }}>{"//"}</span>{" "}
                <span style={{ color: "#fff", fontWeight: 500 }}>
                  {shadeAll ? SLOT_LABEL.overview : SLOT_LABEL[focus]}
                </span>
                {browsing && (
                  <>
                    {" "}
                    <span style={{ color: "var(--fx-ink-faint)" }}>·</span>{" "}
                    <span style={{ color: "#fff", fontWeight: 500 }}>
                      {pickingShader ? "Shader" : "Ornament"}
                    </span>
                  </>
                )}
              </p>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ width: 46, height: 2, background: "#fff" }} />
                <span
                  style={{
                    flex: 1,
                    height: 1,
                    background:
                      "linear-gradient(90deg, rgba(255,255,255,0.42), rgba(255,255,255,0.06))",
                  }}
                />
              </div>
            </div>

            {/* Rail + browse column */}
            <div style={{ display: "flex", gap: 22, marginTop: 22, flex: 1, minHeight: 0 }}>
              {browsing && (
                <SlotRail
                  focus={focus}
                  onFocus={onFocusRail}
                  items={look.items}
                  status={status}
                />
              )}

              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                {!browsing ? (
                  <OverviewPanel
                    items={look.items}
                    shaders={look.shaders}
                    onEdit={editSlot}
                    onResetAll={resetAll}
                    onShadeAll={() => setShadeAll(true)}
                    shadeAllArmed={shadeAll}
                  />
                ) : (
                  <>
                    {/* Layer switch: default / ornament / shader for this slot */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 22,
                      }}
                    >
                      <button
                        className="fx-btn"
                        onClick={clearFocused}
                        title={
                          shadeAll
                            ? "Remove every shader"
                            : `Remove this ${pickingShader ? "shader" : "piece"}`
                        }
                        style={{ height: 74, padding: "0 20px" }}
                      >
                        Default
                      </button>
                      <div style={{ width: 14 }} />
                      {!shadeAll && (
                        <>
                          <button
                            className="fx-tile"
                            data-selected={layer === "gear"}
                            title="Ornament"
                            onClick={() => setLayer("gear")}
                            style={{
                              width: 74,
                              height: 74,
                              overflow: "hidden",
                              borderColor: focusedItem
                                ? tierColor(focusedItem.tier)
                                : "var(--fx-line)",
                            }}
                          >
                            <span className="fx-tile__fill" />
                            {focusedItem?.icon && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={focusedItem.icon} alt="" />
                            )}
                          </button>
                          <button
                            className="fx-tile"
                            data-selected={layer === "shader"}
                            title="Shader"
                            onClick={() => setLayer("shader")}
                            disabled={!focusedItem}
                            style={{
                              width: 74,
                              height: 74,
                              overflow: "hidden",
                              background:
                                "linear-gradient(135deg,#f3efe4 0 50%,#9aa7b2 50% 100%)",
                            }}
                          >
                            {focusedShader?.icon && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={focusedShader.icon} alt="" />
                            )}
                          </button>
                        </>
                      )}
                      <button
                        className="fx-tile"
                        data-selected={favoritesOnly}
                        title="Show favourites only (shift-click a tile to favourite it)"
                        onClick={() => setFavoritesOnly((v) => !v)}
                        style={{
                          width: 74,
                          height: 74,
                          display: "grid",
                          placeItems: "center",
                          fontSize: 20,
                          color: favoritesOnly ? "var(--fx-gold)" : "var(--fx-ink-dim)",
                        }}
                      >
                        ★
                      </button>
                    </div>

                    {pickingShader ? (
                      <ShaderPicker
                        selectedShaderHash={focusedShader?.hash ?? null}
                        onSelect={onPickShader}
                        favoritesOnly={favoritesOnly}
                        favorites={favorites}
                        onToggleFavorite={toggleFavorite}
                      />
                    ) : (
                      <ItemBrowser
                        selectedHash={focusedItem?.hash ?? null}
                        onSelect={onPickItem}
                        fixedSlot={focus === "overview" ? undefined : focus}
                        fixedClassType={look.classType}
                        favoritesOnly={favoritesOnly}
                        favorites={favorites}
                        onToggleFavorite={toggleFavorite}
                      />
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Saved sets · class · light */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 34,
                marginTop: "auto",
                paddingTop: 20,
                flexWrap: "wrap",
              }}
            >
              <div>
                <p className="fx-label">Saved sets</p>
                <div style={{ display: "flex", gap: 8 }}>
                  {sets.map((set) => {
                    const cover = ARMOR_SLOTS.map((s) => set.items[s.key]).find((i) => i?.icon);
                    return (
                      <button
                        key={set.id}
                        className="fx-tile"
                        title={`${set.name} — shift-click to delete`}
                        onClick={(e) => (e.shiftKey ? deleteSet(set.id) : loadSet(set))}
                        style={{ width: 52, height: 52, overflow: "hidden" }}
                      >
                        <span className="fx-tile__fill" />
                        {cover?.icon && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cover.icon} alt="" />
                        )}
                      </button>
                    );
                  })}
                  <button
                    className="fx-tile"
                    title="Save the current look"
                    onClick={saveCurrentSet}
                    style={{
                      width: 52,
                      height: 52,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 17,
                      color: "var(--fx-ink-dim)",
                      background: "transparent",
                      borderStyle: "dashed",
                    }}
                  >
                    +
                  </button>
                </div>
              </div>

              <div>
                <p className="fx-label">Class</p>
                <div style={{ display: "flex", gap: 14 }}>
                  {CLASSES.map((c) => (
                    <button
                      key={c.value}
                      className="fx-tab"
                      data-active={look.classType === c.value}
                      onClick={() => changeClass(c.value)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="fx-label" style={{ marginTop: 16 }}>
                  Light
                </p>
                <div style={{ display: "flex", gap: 14 }}>
                  {LIGHTS.map((l) => (
                    <button
                      key={l.value}
                      className="fx-tab"
                      data-active={light === l.value}
                      onClick={() => setLight(l.value)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Stage: the assembled Guardian ── */}
        <div className="fx-stage">
          <ViewportBoundary
            key={viewportKey}
            fallback={(error) => (
              <CrashScreen detail={error.message} onRelaunch={reloadViewport} />
            )}
          >
            <ModelViewer
              light={light}
              showGrid={false}
              rawOutput={debugChannel !== 0}
              toneMapping={toneMapping}
            >
              <CharacterModel
                pieces={pieces}
                onPieceStatus={onPieceStatus}
                onModel={onCharacterModel}
              />
              <SlotFocusCamera
                character={characterRef}
                slot={focus === "overview" ? null : focus}
                revision={framingRevision}
              />
            </ModelViewer>
          </ViewportBoundary>

          {booted && equippedCount === 0 && <EmptyStage />}
        </div>
      </div>

      {/* ── Top-right: account, history, dev ── */}
      <div
        className="fx-actions"
        style={{
          position: "absolute",
          top: 43,
          right: 48,
          display: "flex",
          alignItems: "center",
          gap: 10,
          zIndex: 20,
        }}
      >
        <button
          className="fx-btn"
          onClick={() => setGateDone(false)}
          title={activeCharacter ? "Switch Guardian" : "Bungie account"}
          style={{ padding: "10px 15px", fontSize: 11 }}
        >
          {activeCharacter ? activeCharacter.className : "Sign in"}
        </button>
        <button
          className="fx-btn"
          title="Rebuild the canvas and reload every piece"
          onClick={reloadViewport}
          style={{ width: 36, height: 36, padding: 0, fontSize: 15 }}
        >
          ⟳
        </button>
        <button
          className="fx-btn"
          title="Undo"
          onClick={undo}
          disabled={past.current.length === 0}
          style={{ width: 36, height: 36, padding: 0, fontSize: 15 }}
        >
          ↺
        </button>
        <button
          className="fx-btn"
          title="Redo"
          onClick={redo}
          disabled={future.current.length === 0}
          style={{ width: 36, height: 36, padding: 0, fontSize: 15 }}
        >
          ↻
        </button>
        <button
          className="fx-btn"
          onClick={revert}
          disabled={!baseline.current}
          title="Back to the set this session started from"
          style={{ padding: "10px 15px", fontSize: 11 }}
        >
          Revert
        </button>
        <button
          className="fx-btn fx-btn--solid"
          onClick={saveCurrentSet}
          style={{ padding: "10px 17px", fontSize: 11 }}
        >
          Save set
        </button>
        <button
          className="fx-btn"
          title="Developer tools"
          onClick={() => setDevOpen((v) => !v)}
          style={{
            width: 36,
            height: 36,
            padding: 0,
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            letterSpacing: 0,
            color: devOpen ? "var(--fx-gold)" : "var(--fx-ink-dim)",
          }}
        >
          &lt;/&gt;
        </button>
      </div>

      {/* ── Bottom-right: key legend ── */}
      <div
        className="fx-legend"
        style={{
          position: "absolute",
          right: 48,
          bottom: 34,
          display: "flex",
          alignItems: "center",
          gap: 20,
          zIndex: 20,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="fx-key">TAB</span>
          <span className="fx-hint">{menuHidden ? "Show menu" : "Hide menu"}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="fx-key">ESC</span>
          <span className="fx-hint">Overview</span>
        </span>
      </div>

      {/* ── Developer drawer ── */}
      {devOpen && (
        <div
          className="fx-dev"
          style={{
            position: "absolute",
            right: 48,
            top: 100,
            bottom: 90,
            width: 330,
            padding: 18,
            overflowY: "auto",
            zIndex: 30,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <p
              style={{
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: "0.3em",
                fontSize: 10,
                color: "var(--fx-gold)",
              }}
            >
              Developer · gearstack
            </p>
            <button
              onClick={() => setDevOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "var(--fx-ink-dim)",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 11, lineHeight: 1.6 }}>
            Live tuning across every equipped piece. Each control defaults to the
            normal in-game render.
          </p>
          <button
            className="d2-btn"
            onClick={randomizeSet}
            title="Dress every slot in a random piece + random shader (hashes logged to the console)"
            style={{ fontSize: 11, padding: "4px 8px", marginBottom: 16, width: "100%" }}
          >
            Randomize set
          </button>
          <GearDebugControls
            debugChannel={debugChannel}
            onSelectDebugChannel={selectDebugChannel}
            toneMapping={toneMapping}
            onSelectToneMapping={setToneMapping}
            roughnessRemapMode={roughnessRemapMode}
            onSelectRoughnessRemapMode={selectRoughnessRemapMode}
            wearRemapMode={wearRemapMode}
            onSelectWearRemapMode={selectWearRemapMode}
            glowCapable={glowCapable}
            glowEnabled={glowEnabled}
            onToggleGlow={toggleGlowEnabled}
            bandMode={bandMode}
            onSelectBandMode={selectBandMode}
            bands={bands}
            onUpdateBands={updateBands}
            onResetBands={() => updateBands(BAND_DEFAULTS)}
          />
        </div>
      )}

      {/* ── Full-stage screens ── */}
      {showSignIn && <SignInScreen onManual={skipAccount} />}
      {showRoster && (
        <RosterScreen
          characters={characters.map((c) => ({
            characterId: c.characterId,
            className: c.className,
            light: c.light,
            emblemPath: c.emblemPath,
            slots: c.items.filter((it) => ARMOR_SLOTS.some((s) => s.key === it.slot)).length,
          }))}
          onPick={(id) => {
            const c = characters.find((x) => x.characterId === id);
            if (c) equipLoadout(c);
          }}
          onSkip={() => setGateDone(true)}
        />
      )}
      {showLoading && (
        <LoadingScreen
          pieces={ARMOR_SLOTS.map((s) => ({ label: s.label, status: status[s.key] }))}
          onReload={reloadViewport}
        />
      )}
    </div>
  );
}

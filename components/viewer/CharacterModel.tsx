"use client";

/**
 * Renders a full character as the union of its equipped armor pieces.
 *
 * Pieces are loaded in Destiny's native bind-pose space (so they align on one
 * body) and assembled into a shared group that is framed as a whole. Loading is
 * incremental and cached per slot: swapping one slot only reloads that piece,
 * and the body re-frames as pieces come and go.
 */
import { disposeModel } from "@/lib/loader/resources";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { loadPiece, frameCharacter } from "@/lib/loader/loadCharacter";
import { advanceGlowTime, advancePatternTime } from "@/lib/materials/gearMaterial";

export type SlotKey = "helmet" | "gauntlets" | "chest" | "legs" | "classItem";

export interface EquippedPiece {
  itemHash: number;
  shaderHash?: number | null;
  /** Skip the cloak's hood geometry (index 0) — set by the caller based on
   * whether the equipped helmet is in the hood-hiding list. */
  hideHood?: boolean;
}

export type PieceStatus = "loading" | "ready" | "error";

interface Props {
  /** slot -> equipped item (or null/absent for an empty slot). */
  pieces: Partial<Record<SlotKey, EquippedPiece | null>>;
  onPieceStatus?: (slot: SlotKey, status: PieceStatus, error?: string) => void;
  /** Fires once with the persistent character wrapper group — lets a parent
   * reach into the assembled scene, e.g. to drive the shader debug controls
   * across every equipped piece. */
  onModel?: (group: THREE.Group) => void;
}

function keyOf(p: EquippedPiece): string {
  return `${p.itemHash}:${p.shaderHash ?? 0}:${p.hideHood ? 1 : 0}`;
}

export default function CharacterModel({ pieces, onPieceStatus, onModel }: Props) {
  // Persistent scene graph: wrapper (framed) -> body (holds native pieces).
  const wrapperRef = useRef<THREE.Group | null>(null);
  const bodyRef = useRef<THREE.Group | null>(null);
  if (!wrapperRef.current) {
    wrapperRef.current = new THREE.Group();
    bodyRef.current = new THREE.Group();
    wrapperRef.current.add(bodyRef.current);
  }

  const loadedRef = useRef<Map<SlotKey, { key: string; group: THREE.Group }>>(
    new Map(),
  );
  const tokenRef = useRef(0);

  // Serialize the requested set so the effect only reruns on real changes.
  const sig = (Object.keys(pieces) as SlotKey[])
    .sort()
    .map((s) => `${s}=${pieces[s] ? keyOf(pieces[s]!) : ""}`)
    .join("|");

  useEffect(() => {
    const token = ++tokenRef.current;
    const controller = new AbortController();
    const body = bodyRef.current!;
    const wrapper = wrapperRef.current!;
    const loaded = loadedRef.current;

    // Remove only pieces whose slot was CLEARED. A slot that merely changed
    // item/shader keeps its current group on-screen until the replacement has
    // finished loading (see the swap below), so swapping a piece never flashes
    // an empty slot.
    for (const [slot, entry] of [...loaded]) {
      if (!pieces[slot]) {
        body.remove(entry.group);
        disposeModel(entry.group);
        loaded.delete(slot);
      }
    }
    frameCharacter(body, wrapper);

    // Load pieces that are missing (sequential — keeps memory + fetch modest).
    (async () => {
      for (const slot of Object.keys(pieces) as SlotKey[]) {
        const p = pieces[slot];
        if (!p) continue;
        const key = keyOf(p);
        if (loaded.get(slot)?.key === key) continue;

        onPieceStatus?.(slot, "loading");
        try {
          const { group } = await loadPiece(p.itemHash, p.shaderHash, p.hideHood, controller.signal);
          // Tag the piece so consumers of the exposed wrapper can find one
          // slot's geometry — e.g. framing the camera on the piece being edited.
          group.userData.slot = slot;
          if (controller.signal.aborted || token !== tokenRef.current) {
            disposeModel(group);
            return; // a newer request superseded this run
          }
          // Replace any stale group for this slot (item may have changed again).
          const prev = loaded.get(slot);
          if (prev) {
            body.remove(prev.group);
            disposeModel(prev.group);
          }
          body.add(group);
          loaded.set(slot, { key, group });
          frameCharacter(body, wrapper);
          onPieceStatus?.(slot, "ready");
        } catch (err) {
          if (controller.signal.aborted || token !== tokenRef.current) return;
          onPieceStatus?.(
            slot,
            "error",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Expose for console/scene inspection (dev aid) and hand the persistent
  // wrapper to the parent so it can drive the shader debug controls. The
  // wrapper is created once and never replaced, so a single fire is enough —
  // the editor re-applies settings per piece via onPieceStatus("ready").
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__character = wrapperRef.current;
    onModel?.(wrapperRef.current!);
    const loaded = loadedRef.current;
    const wrapper = wrapperRef.current;
    return () => {
      for (const entry of loaded.values()) disposeModel(entry.group);
      loaded.clear();
      const debug = window as unknown as Record<string, unknown>;
      if (debug.__character === wrapper) delete debug.__character;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the ability-glow flicker (see gearMaterial.ts animatedGlow) and the
  // pattern-shimmer warp (see isPatternGroup) across every equipped piece — a
  // no-op traversal for pieces with neither material. Without this, uGlowTime/
  // uPatternTime never advance and the effects render as a flat, unmoving
  // value instead of animating.
  useFrame((_, delta) => {
    advanceGlowTime(wrapperRef.current!, delta);
    advancePatternTime(wrapperRef.current!, delta);
  });

  return <primitive object={wrapperRef.current} />;
}

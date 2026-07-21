"use client";

/**
 * Renders a full character as the union of its equipped armor pieces.
 *
 * Pieces are loaded in Destiny's native bind-pose space (so they align on one
 * body) and assembled into a shared group that is framed as a whole. Loading is
 * incremental and cached per slot: swapping one slot only reloads that piece,
 * and the body re-frames as pieces come and go.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { loadPiece, frameCharacter } from "@/lib/loader/loadCharacter";

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
}

function keyOf(p: EquippedPiece): string {
  return `${p.itemHash}:${p.shaderHash ?? 0}:${p.hideHood ? 1 : 0}`;
}

/** Dispose a piece's geometry, materials, and all textures it owns. */
function disposeGroup(group: THREE.Group): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const maps = (mesh.userData.maps ?? {}) as Record<string, THREE.Texture>;
    for (const t of Object.values(maps)) t?.dispose?.();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose?.();
  });
}

export default function CharacterModel({ pieces, onPieceStatus }: Props) {
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
    const body = bodyRef.current!;
    const wrapper = wrapperRef.current!;
    const loaded = loadedRef.current;

    // Remove pieces whose slot was cleared or whose item/shader changed.
    for (const [slot, entry] of [...loaded]) {
      const desired = pieces[slot];
      if (!desired || keyOf(desired) !== entry.key) {
        body.remove(entry.group);
        disposeGroup(entry.group);
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
          const { group } = await loadPiece(p.itemHash, p.shaderHash, p.hideHood);
          if (token !== tokenRef.current) {
            disposeGroup(group);
            return; // a newer request superseded this run
          }
          // Replace any stale group for this slot (item may have changed again).
          const prev = loaded.get(slot);
          if (prev) {
            body.remove(prev.group);
            disposeGroup(prev.group);
          }
          body.add(group);
          loaded.set(slot, { key, group });
          frameCharacter(body, wrapper);
          onPieceStatus?.(slot, "ready");
        } catch (err) {
          if (token !== tokenRef.current) return;
          onPieceStatus?.(
            slot,
            "error",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Expose for console/scene inspection (dev aid).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__character = wrapperRef.current;
  }, []);

  return <primitive object={wrapperRef.current} />;
}

"use client";

/**
 * Loads and renders a single item's gear model inside the R3F canvas.
 *
 * On success it renders the real parsed geometry. If any stage of the pipeline
 * fails it renders a stylized proxy mesh instead (per the build brief's
 * fallback) and reports the error upward so the POC can state which path we're
 * on.
 */
import { useEffect, useState } from "react";
import * as THREE from "three";
import { loadGearModel, type GearModelDebug } from "@/lib/loader/loadGearModel";

export type LoadPath = "loading" | "real" | "fallback";

interface Props {
  itemHash: number;
  shaderHash?: number | null;
  onStatus?: (s: {
    path: LoadPath;
    debug?: GearModelDebug;
    error?: string;
  }) => void;
  /** Fires with the loaded group (or null on reset/failure) — lets a parent
   * reach into the live scene, e.g. to toggle the gearstack debug channel. */
  onModel?: (group: THREE.Group | null) => void;
}

export default function GearModel({ itemHash, shaderHash, onStatus, onModel }: Props) {
  const [group, setGroup] = useState<THREE.Group | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    setGroup(null);
    setFailed(false);
    onStatus?.({ path: "loading" });
    onModel?.(null);

    loadGearModel(itemHash, { shaderHash })
      .then(({ group, debug }) => {
        if (disposed) return;
        // Dev aid: expose the loaded model for console/scene inspection.
        (window as unknown as Record<string, unknown>).__gear = group;
        setGroup(group);
        onStatus?.({ path: "real", debug });
        onModel?.(group);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setFailed(true);
        onStatus?.({
          path: "fallback",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemHash, shaderHash]);

  if (group) return <primitive object={group} />;
  if (failed) return <FallbackModel />;
  return null;
}

/**
 * Stylized proxy: a blocky, angular armor silhouette with dyed materials.
 * Signals visually that we're on the fallback path, not the real asset.
 */
function FallbackModel() {
  const primary = new THREE.MeshStandardMaterial({
    color: 0x6a7078,
    metalness: 0.5,
    roughness: 0.5,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x4fd0e0,
    metalness: 0.3,
    roughness: 0.4,
    emissive: new THREE.Color(0x0b3a40),
  });

  return (
    <group>
      {/* torso */}
      <mesh material={primary} position={[0, 0.15, 0]}>
        <boxGeometry args={[0.9, 1.0, 0.5]} />
      </mesh>
      {/* head */}
      <mesh material={accent} position={[0, 0.95, 0]}>
        <boxGeometry args={[0.4, 0.4, 0.4]} />
      </mesh>
      {/* shoulders */}
      <mesh material={primary} position={[-0.65, 0.45, 0]}>
        <boxGeometry args={[0.4, 0.35, 0.55]} />
      </mesh>
      <mesh material={primary} position={[0.65, 0.45, 0]}>
        <boxGeometry args={[0.4, 0.35, 0.55]} />
      </mesh>
      {/* legs */}
      <mesh material={primary} position={[-0.25, -0.75, 0]}>
        <boxGeometry args={[0.35, 0.9, 0.4]} />
      </mesh>
      <mesh material={primary} position={[0.25, -0.75, 0]}>
        <boxGeometry args={[0.35, 0.9, 0.4]} />
      </mesh>
    </group>
  );
}

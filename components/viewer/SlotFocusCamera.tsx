"use client";

/**
 * Frames the camera on the piece being edited.
 *
 * Destiny's appearance screen pulls in on whatever you're customizing — head
 * and shoulders for a helmet, the full body for the set overview. The framing
 * here is measured, not authored: it reads the world bounding box of the loaded
 * geometry for the focused slot (tagged by CharacterModel) and fits it to the
 * current camera/viewport, so it stays correct for pieces of any size.
 *
 * The move keeps the user's current viewing direction — only the pivot and the
 * distance change — and any manual orbit cancels it immediately.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { SlotKey } from "./CharacterModel";

interface Props {
  /** The persistent character wrapper handed over by CharacterModel. */
  character: React.RefObject<THREE.Group | null>;
  /** Slot to frame, or null for the whole assembled body. */
  slot: SlotKey | null;
  /** Bump to re-measure — a piece finished loading, or the set changed. */
  revision: number;
}

/** Leave this much empty space around the framed subject. */
const MARGIN = 1.35;
/** Approach rate; higher converges faster (units: 1/s). */
const EASE = 4.5;

/** The slice of OrbitControls this needs (r3f types `controls` as unknown). */
interface Controls {
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

function subjectOf(root: THREE.Object3D, slot: SlotKey | null): THREE.Object3D | null {
  if (!slot) return root;
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.userData.slot === slot) found = o;
  });
  return found;
}

export default function SlotFocusCamera({ character, slot, revision }: Props) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const size = useThree((s) => s.size);
  const goal = useRef<{ center: THREE.Vector3; distance: number } | null>(null);

  // Any manual orbit/zoom wins — drop the pending move rather than fight it.
  useEffect(() => {
    if (!controls) return;
    const cancel = () => {
      goal.current = null;
    };
    controls.addEventListener("start", cancel);
    return () => controls.removeEventListener("start", cancel);
  }, [controls]);

  useEffect(() => {
    const root = character.current;
    if (!root || !controls) return;
    const subject = subjectOf(root, slot);
    if (!subject) return;

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(subject);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (sphere.radius <= 0) return;

    // Fit the subject's bounding sphere to the narrower of the two frustum
    // half-angles, so it's fully in shot in portrait or landscape viewports.
    // The camera's own aspect can still be the pre-layout 0 on the first pass
    // (see RendererSizeSync), which would put the fit distance at infinity —
    // fall back to the measured canvas.
    const aspect =
      camera.aspect > 0 ? camera.aspect : size.height > 0 ? size.width / size.height : 1;
    const vFov = (camera.fov * Math.PI) / 180 / 2;
    const hFov = Math.atan(Math.tan(vFov) * aspect);
    const distance = THREE.MathUtils.clamp(
      (sphere.radius / Math.sin(Math.min(vFov, hFov))) * MARGIN,
      controls.minDistance ?? 0.1,
      controls.maxDistance ?? 100,
    );
    goal.current = { center: sphere.center.clone(), distance };
  }, [character, controls, camera, size, slot, revision]);

  useFrame((_, delta) => {
    const g = goal.current;
    if (!g || !controls) return;

    const k = 1 - Math.exp(-EASE * Math.min(delta, 0.1));
    controls.target.lerp(g.center, k);

    // Hold the current view direction; only the pivot and distance move.
    const dir = camera.position.clone().sub(controls.target);
    const length = dir.length() || 1;
    dir.divideScalar(length);
    const next = THREE.MathUtils.lerp(length, g.distance, k);
    camera.position.copy(controls.target).addScaledVector(dir, next);

    if (
      controls.target.distanceTo(g.center) < 0.002 &&
      Math.abs(next - g.distance) < 0.002
    ) {
      goal.current = null;
    }
  });

  return null;
}

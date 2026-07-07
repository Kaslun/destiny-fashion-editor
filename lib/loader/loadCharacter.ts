/**
 * Multi-slot character assembly.
 *
 * Destiny armor pieces are authored in a shared bind-pose (Guardian) space, so
 * when each piece is loaded WITHOUT per-item centering (`frame: false`) they
 * already sit at the correct height/offset relative to one another. This module
 * loads pieces in that native space and frames the whole assembled body once.
 *
 * We don't have the base character mesh yet (that needs the profile/skeleton
 * from the API), so the "character" is the union of the equipped armor pieces —
 * good enough to preview a full transmog set.
 */
import * as THREE from "three";
import { loadGearModel, type GearModelDebug } from "./loadGearModel";

export interface LoadedPiece {
  /** Native bind-pose group for one equipped item. */
  group: THREE.Group;
  debug: GearModelDebug;
}

/** Load one equipped piece in native (un-framed) space for assembly. */
export async function loadPiece(
  itemHash: number,
  shaderHash?: number | null,
): Promise<LoadedPiece> {
  const { group, debug } = await loadGearModel(itemHash, {
    shaderHash,
    frame: false,
  });
  return { group, debug };
}

/**
 * Center a body group (holding one or more native pieces) inside `wrapper` and
 * scale it to a standard viewing size, feet-down. Call whenever pieces change.
 */
export function frameCharacter(body: THREE.Group, wrapper: THREE.Group): void {
  // Reset any prior framing so the measurement is of the raw union in Destiny's
  // native Z-up shared space.
  body.position.set(0, 0, 0);
  wrapper.scale.setScalar(1);
  wrapper.rotation.set(0, 0, 0);
  wrapper.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(body);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Frame on the tallest axis (a standing body is height-dominant) so the whole
  // Guardian fits a ~2-unit viewport regardless of the native unit scale.
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  // Center the union at the origin, scale to fit, then rotate Destiny's Z-up
  // space into Three's Y-up so the Guardian stands upright.
  body.position.set(-center.x, -center.y, -center.z);
  wrapper.scale.setScalar(2 / maxDim);
  wrapper.rotation.x = -Math.PI / 2;
}

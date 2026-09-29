/**
 * D2 gear material arithmetic, shared by the CPU reference and TSL graph.
 * Sources and limits: docs/DESTINY-MATERIALS.md. Remaps are bias, scale,
 * lower bound, range WIDTH (not four range endpoints).
 */
export type MaterialRemap = [number, number, number, number];
export const IDENTITY_REMAP: MaterialRemap = [0, 1, 0, 1];
export const NO_WEAR_REMAP: MaterialRemap = [0, 0, 1, 0];

/** Minimal arithmetic adapter lets numerical tests exercise the GPU formula. */
interface Arithmetic<T> {
  add(a: T, b: T): T;
  mul(a: T, b: T): T;
  clamp(a: T, lo: T, hi: T): T;
}

export function authoredRemap<T>(
  value: T, bias: T, scale: T, lower: T, width: T, op: Arithmetic<T>,
): T {
  return op.clamp(op.add(op.mul(value, scale), bias), lower, op.add(lower, width));
}

export function evaluateRemap(value: number, remap: MaterialRemap): number {
  return authoredRemap(value, ...remap, {
    add: (a, b) => a + b,
    mul: (a, b) => a * b,
    clamp: (a, lo, hi) => Math.min(Math.max(a, lo), hi),
  });
}

export const GEARSTACK = {
  alphaRange: 32 / 255,
  dyeThreshold: 40 / 255,
  emissiveStart: 40 / 255,
  wearStart: 48 / 255,
} as const;

export function decodeGearstack([r, g, b, a]: MaterialRemap) {
  const saturate = (v: number) => Math.min(1, Math.max(0, v));
  return {
    ao: saturate(r),
    smoothness: saturate(g),
    opacity: saturate(b / GEARSTACK.alphaRange),
    emissive: saturate((b - GEARSTACK.emissiveStart) / (1 - GEARSTACK.emissiveStart)),
    dyed: a >= GEARSTACK.dyeThreshold,
    metalness: saturate(a / GEARSTACK.alphaRange),
    wearSignal: saturate((a - GEARSTACK.wearStart) / (1 - GEARSTACK.wearStart)),
  };
}

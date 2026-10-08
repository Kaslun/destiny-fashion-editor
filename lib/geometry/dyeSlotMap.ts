import type { RgbaImage } from "./dataTexture";
import type { TexturePlate } from "./renderMetadata";

// Reference: Destiny Collada Generator template.shader's DyeSlotTexture path.
// RGB are categorical flags, not blend weights. Black retains the geometry ID.
// Red/magenta -> secondary 0, green -> primary 1, yellow -> secondary 1,
// blue/cyan -> primary 2, white -> secondary 2.
export interface DyeFlagOps<N, B> {
  aboveHalf: (v: N) => B;
  and: (a: B, b: B) => B;
  not: (v: B) => B;
  select: (condition: B, yes: N, no: N) => N;
  value: (v: number) => N;
}

/** Decode sampled RGB flags, not interpolated numeric material IDs. */
export function dyeIdFromFlags<N, B>(r: N, g: N, b: N, ops: DyeFlagOps<N, B>): N {
  const red = ops.aboveHalf(r), green = ops.aboveHalf(g), blue = ops.aboveHalf(b);
  const { and, not, select, value } = ops;
  return select(and(and(red, green), blue), value(5),
    select(and(not(red), blue), value(4), select(and(red, green), value(3),
      select(and(green, not(blue)), value(2), select(red, value(1), value(-1))))));
}

const scalarFlags: DyeFlagOps<number, boolean> = {
  aboveHalf: (v) => v > 0.5, and: (a, b) => a && b, not: (v) => !v,
  select: (c, a, b) => c ? a : b, value: (v) => v,
};

/** D2 mobile reports the gearstack-sized canvas for dyeslot, while its
 * placement coordinates and sizes are already at quarter resolution.
 * The reference exporter's dyemap canvas divides both dimensions by four.
 * Do not scale placements or stretch an individual tile to fill the atlas.
 */
export function dyeSlotPlate(plate: TexturePlate): TexturePlate {
  const [w, h] = plate.size;
  if (w < 4 || h < 4 || w % 4 || h % 4) throw new Error("Invalid mobile dyeslot canvas dimensions");
  if (plate.placements.some((p) => p.x < 0 || p.y < 0 || p.w <= 0 || p.h <= 0 ||
    p.x + p.w > w / 4 || p.y + p.h > h / 4)) {
    throw new Error("Dyeslot placements do not fit the quarter-resolution canvas");
  }
  return { ...plate, size: [w / 4, h / 4] };
}

/** Decode texel centers for diagnostics or explicit nearest-sampled ID maps.
 * The live renderer filters RGB flags first and calls dyeIdFromFlags per pixel.
 * R stores ID+1 (1..6), A marks an override.
 * Zero/transparent texels preserve the geometry's slot AND primary/secondary.
 * The resulting texture must use nearest sampling without mipmaps.
 */
export function decodeDyeSlotMap(source: RgbaImage): RgbaImage {
  const data = new Uint8Array(source.data.length);
  for (let p = 0; p < data.length; p += 4) {
    if (source.data[p + 3] < 128) continue;
    const id = dyeIdFromFlags(source.data[p] / 255, source.data[p + 1] / 255, source.data[p + 2] / 255, scalarFlags);
    if (id < 0) continue;
    data[p] = id + 1;
    data[p + 3] = 255;
  }
  return { width: source.width, height: source.height, data };
}

import type { RgbaImage } from "./dataTexture";
import type { TexturePlate } from "./renderMetadata";

// Reference: Destiny Collada Generator template.shader's DyeSlotTexture path.
// RGB are categorical flags, not blend weights. Black retains the geometry ID.
// Red/magenta -> secondary 0, green -> primary 1, yellow -> secondary 1,
// blue/cyan -> primary 2, white -> secondary 2.
const COLOR_IDS = [-1, 1, 2, 3, 4, 1, 4, 5] as const;

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

/** Decode once before GPU upload. R stores ID+1 (1..6), A marks an override.
 * Zero/transparent texels preserve the geometry's slot AND primary/secondary.
 * The resulting texture must use nearest sampling without mipmaps.
 */
export function decodeDyeSlotMap(source: RgbaImage): RgbaImage {
  const data = new Uint8Array(source.data.length);
  for (let p = 0; p < data.length; p += 4) {
    if (source.data[p + 3] < 128) continue;
    const bits = (source.data[p] >= 128 ? 1 : 0) |
      (source.data[p + 1] >= 128 ? 2 : 0) | (source.data[p + 2] >= 128 ? 4 : 0);
    const id = COLOR_IDS[bits];
    if (id < 0) continue;
    data[p] = id + 1;
    data[p + 3] = 255;
  }
  return { width: source.width, height: source.height, data };
}

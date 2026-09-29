import type { RgbaImage } from "./dataTexture";

// These are conservative reconstruction thresholds, not Bungie material IDs.
// They operate locally (the four source texels around a pixel), so they cannot
// turn a color motif, shadow, or an entire wear band into a different dye slot.
const alphaClass = (a: number) => a >= 40 ? 3 : a >= 24 ? 2 : a > 8 ? 1 : 0;
const blueClass = (b: number) => b >= 40 ? 2 : b > 32 ? 1 : 0;
const offset = (im: RgbaImage, u: number, v: number) =>
  (Math.min(im.height - 1, Math.max(0, Math.floor(v * im.height))) * im.width +
    Math.min(im.width - 1, Math.max(0, Math.floor(u * im.width)))) * 4;
const distance = (a: Uint8Array, ai: number, b: Uint8Array, bi: number, channels: number) => {
  let sum = 0;
  for (let c = 0; c < channels; c++) sum += ((a[ai + c] - b[bi + c]) / 255) ** 2;
  return Math.sqrt(sum / channels);
};

export interface MaterialBoundaryResult {
  image: RgbaImage;
  /** Changes to dye eligibility or the broad undyed metalness class. */
  estimatedTexels: number;
}

/** Joint reconstruction of the packed material map at diffuse resolution.
 * Alpha determines dye/wear/undyed metalness; it is never decoded as slot IDs.
 * A higher-resolution color edge may move a boundary by less than one source
 * texel only when smoothness or normal detail corroborates that edge. Within
 * a region, interpolate continuous values without crossing packed classes.
 * Run on individual atlas tiles to avoid borrowing from unrelated UV islands.
 */
export function reconstructMaterialBoundaries(
  source: RgbaImage, diffuse?: RgbaImage, normal?: RgbaImage,
): MaterialBoundaryResult {
  if (!diffuse || diffuse.width < source.width || diffuse.height < source.height ||
      (diffuse.width === source.width && diffuse.height === source.height) ||
      diffuse.width * diffuse.height > 4_194_304) {
    return { image: source, estimatedTexels: 0 };
  }
  const { width, height } = diffuse;
  const data = new Uint8Array(width * height * 4);
  let estimatedTexels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width, v = (y + 0.5) / height;
    const sx = u * source.width - 0.5, sy = v * source.height - 0.5;
    const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top;
    const center = offset(source, u, v), dest = (y * width + x) * 4;
    const targetNormal = normal ? offset(normal, u, v) : 0;
    const candidates = [];
    for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
      const cu = (Math.max(0, Math.min(source.width - 1, left + cx)) + 0.5) / source.width;
      const cv = (Math.max(0, Math.min(source.height - 1, top + cy)) + 0.5) / source.height;
      const i = offset(source, cu, cv);
      candidates.push({ i, weight: (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy),
        color: distance(diffuse.data, dest, diffuse.data, offset(diffuse, cu, cv), 3),
        normal: normal ? distance(normal.data, targetNormal, normal.data, offset(normal, cu, cv), 2) : 0 });
    }
    const original = candidates.find((c) => c.i === center)!;
    let anchor = original;
    for (const c of candidates) {
      // Do not infer from deep occlusion, cutouts, glow, a weak color match, or
      // color alone. This deliberately leaves ambiguous boundaries unchanged.
      const supported = Math.abs(source.data[c.i + 1] - source.data[center + 1]) >= 24 ||
        (normal && original.normal - c.normal > 0.08);
      if (c.weight >= 0.12 && c.color < 0.045 && original.color - c.color > 0.075 &&
          c.color < anchor.color && c.normal <= original.normal + 0.04 && supported &&
          source.data[c.i] >= 32 && source.data[center] >= 32 &&
          source.data[c.i + 2] === 32 && source.data[center + 2] === 32) anchor = c;
    }
    const a = source.data[anchor.i + 3], b = source.data[anchor.i + 2];
    if (alphaClass(a) !== alphaClass(source.data[center + 3])) estimatedTexels++;
    let total = 0;
    const accum = [0, 0, 0, 0];
    for (const c of candidates) {
      const ca = source.data[c.i + 3], cb = source.data[c.i + 2];
      // Wear gradients are continuous, but neither packed alpha nor blue may
      // be averaged across semantic ranges. Preserve sharp local wear edges.
      if (alphaClass(ca) !== alphaClass(a) || blueClass(cb) !== blueClass(b) ||
          Math.abs(ca - a) > (a >= 40 ? 24 : 8) ||
          Math.abs(source.data[c.i + 1] - source.data[anchor.i + 1]) > 32) continue;
      const weight = c.weight * Math.exp(-c.color * c.color / 0.02 - c.normal * c.normal / 0.02);
      total += weight;
      for (let channel = 0; channel < 4; channel++) accum[channel] += source.data[c.i + channel] * weight;
    }
    for (let channel = 0; channel < 4; channel++) {
      data[dest + channel] = total > 1e-8 ? Math.round(accum[channel] / total) : source.data[anchor.i + channel];
    }
  }
  return { image: { width, height, data }, estimatedTexels };
}

/**
 * Per-channel 3x3 median despeckle for RGBA pixel data, operating in place.
 *
 * Found empirically on Relativism's dyeslot plate (see gearMaterial.ts
 * isPatternGroup's neighbour, the dyeslot argmax decode in makeOpaque):
 * sampling its assembled plate directly showed the big "cyan" (G+B) region is
 * NOT actually ambiguous — G beats B in the per-pixel argmax 86592:768 (99.1%
 * vs 0.9%) — but that 0.9% is isolated single-pixel compression noise sitting
 * inside an otherwise-uniform green field, which reads as visible
 * salt-and-pepper speckle in the resolved-slot debug view even at under 1%
 * density.
 *
 * A median filter is the right tool for exactly this: unlike a box/Gaussian
 * blur (already used elsewhere in this pipeline for chroma cleanup — see
 * loadGearModel.ts's cleanChroma), it doesn't blend across a genuine boundary
 * between two differently-valued regions, so it's safe on ID-mask-style data
 * where blending would corrupt the encoded values — it only replaces a pixel
 * that disagrees with its neighbourhood.
 *
 * R/G/B are despeckled INDEPENDENTLY, not as a combined colour distance — the
 * dyeslot plate's three channels are independent per-slot weights (see the
 * dyeslot-decode comment in gearMaterial.ts), not a correlated colour, so
 * filtering them together would be wrong. Alpha is left untouched.
 */
export function medianDespeckleRGB(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const src = data.slice();
  const window = new Uint8ClampedArray(9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            window[n++] = src[(yy * width + xx) * 4 + ch];
          }
        }
        const sorted = Array.from(window.subarray(0, n)).sort((a, b) => a - b);
        data[idx + ch] = sorted[Math.floor(n / 2)];
      }
    }
  }
}

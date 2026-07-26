import { describe, it, expect } from "vitest";
import { medianDespeckleRGB } from "./despeckle";

/** Build a flat RGBA buffer for a width x height image, one colour everywhere. */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return data;
}

function pixel(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

describe("medianDespeckleRGB", () => {
  it("corrects an isolated single-pixel outlier surrounded by a uniform field", () => {
    const w = 5,
      h = 5;
    const data = solid(w, h, 0, 200, 0); // uniform green field
    // Poke one pixel's blue channel — the exact shape of the Relativism bug
    // (green field, isolated compression noise flipping blue up).
    const noisyIdx = (2 * w + 2) * 4;
    data[noisyIdx + 2] = 220;
    medianDespeckleRGB(data, w, h);
    expect(pixel(data, w, 2, 2)).toEqual([0, 200, 0, 255]);
  });

  it("leaves a uniform image untouched", () => {
    const w = 4,
      h = 4;
    const data = solid(w, h, 10, 20, 30);
    const before = data.slice();
    medianDespeckleRGB(data, w, h);
    expect(data).toEqual(before);
  });

  it("never touches the alpha channel", () => {
    const w = 3,
      h = 3;
    const data = solid(w, h, 0, 0, 0, 128);
    data[(1 * w + 1) * 4] = 255; // noisy R at center
    data[(1 * w + 1) * 4 + 3] = 77; // distinct alpha, should survive as-is
    medianDespeckleRGB(data, w, h);
    expect(pixel(data, w, 1, 1)[3]).toBe(77);
  });

  it("despeckles R/G/B independently, not as a combined colour", () => {
    // A field where R is noisy at one pixel but G/B are already uniform —
    // only R should be corrected, G/B must be untouched regardless of R's value.
    const w = 5,
      h = 5;
    const data = solid(w, h, 50, 100, 150);
    const idx = (2 * w + 2) * 4;
    data[idx] = 5; // R outlier only
    medianDespeckleRGB(data, w, h);
    expect(pixel(data, w, 2, 2)).toEqual([50, 100, 150, 255]);
  });

  it("preserves a real hard edge instead of blending it (unlike a box blur)", () => {
    // Left half 0, right half 255 — a genuine ID-mask-style boundary. A median
    // filter must reproduce it exactly; a blur would produce mid-grey seams.
    const w = 6,
      h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 3 ? 0 : 255;
        const i = (y * w + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const before = data.slice();
    medianDespeckleRGB(data, w, h);
    expect(data).toEqual(before);
  });
});

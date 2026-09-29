import { unzlibSync } from "fflate";

export interface RgbaImage { width: number; height: number; data: Uint8Array }

/** Decode mobile RGB/RGBA PNGs without treating the fourth data channel as
 * transparency. Canvas/ImageBitmap compositing loses RGB at alpha=0 and
 * rounds it at low alpha, corrupting gearstack AO, smoothness and emission.
 */
export function decodeDataPng(bytes: Uint8Array): RgbaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
    throw new Error("Material data texture must be a PNG");
  }
  const width = view.getUint32(16), height = view.getUint32(20);
  const depth = bytes[24], type = bytes[25];
  if (depth !== 8 || (type !== 2 && type !== 6) || bytes[26] || bytes[27] || bytes[28]) {
    throw new Error("Unsupported material PNG encoding (expected non-interlaced 8-bit RGB/RGBA)");
  }
  if (!width || !height || width * height > 16777216) throw new Error("Invalid material PNG dimensions");
  const chunks: Uint8Array[] = [];
  for (let p = 8; p + 12 <= bytes.length;) {
    const length = view.getUint32(p);
    if (p + length + 12 > bytes.length) throw new Error("Truncated material PNG");
    if (view.getUint32(p + 4) === 0x49444154) chunks.push(bytes.subarray(p + 8, p + 8 + length));
    p += length + 12;
  }
  const compressed = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { compressed.set(chunk, offset); offset += chunk.length; }
  const channels = type === 6 ? 4 : 3, stride = width * channels;
  const scan = unzlibSync(compressed);
  if (scan.length !== (stride + 1) * height) throw new Error("Invalid material PNG scanline length");
  const decoded = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = scan[y * (stride + 1)];
    if (filter > 4) throw new Error("Invalid material PNG filter");
    for (let x = 0; x < stride; x++) {
      const pos = y * stride + x;
      const a = x >= channels ? decoded[pos - channels] : 0;
      const b = y ? decoded[pos - stride] : 0;
      const c = y && x >= channels ? decoded[pos - stride - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b :
        filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      decoded[pos] = scan[y * (stride + 1) + 1 + x] + predictor;
    }
  }
  if (channels === 4) return { width, height, data: decoded };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set(decoded.subarray(i * 3, i * 3 + 3), i * 4); data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Copy independent channels, never alpha-blend tiles or interpolate IDs. */
export function placeDataTile(atlas: RgbaImage, tile: RgbaImage, x: number, y: number, w: number, h: number): void {
  for (let dy = Math.max(0, y); dy < Math.min(atlas.height, y + h); dy++) {
    for (let dx = Math.max(0, x); dx < Math.min(atlas.width, x + w); dx++) {
      const sx = Math.min(tile.width - 1, Math.floor((dx - x + 0.5) * tile.width / w));
      const sy = Math.min(tile.height - 1, Math.floor((dy - y + 0.5) * tile.height / h));
      const source = (sy * tile.width + sx) * 4;
      atlas.data.set(tile.data.subarray(source, source + 4), (dy * atlas.width + dx) * 4);
    }
  }
}

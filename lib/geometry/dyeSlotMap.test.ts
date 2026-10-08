import { describe, expect, it } from "vitest";
import { decodeDyeSlotMap, dyeSlotPlate, dyeIdFromFlags, type DyeFlagOps } from "./dyeSlotMap";
import { decodeDataPng, placeDataTile, type RgbaImage } from "./dataTexture";
import { parseRenderMetadata } from "./renderMetadata";
import iron from "./fixtures/iron-dye-map.json";

const pixel = (rgba: number[]) => decodeDyeSlotMap({ width: 1, height: 1, data: new Uint8Array(rgba) }).data;

describe("mobile categorical dye maps", () => {
  it("classifies filtered RGB flags without interpolating numeric material IDs", () => {
    const ops: DyeFlagOps<number, boolean> = {
      aboveHalf: (v) => v > 0.5, and: (a, b) => a && b, not: (v) => !v,
      select: (c, yes, no) => c ? yes : no, value: (v) => v,
    };
    // Red (ID 1) to cyan (ID 4): averaging their IDs would invent ID 2/3.
    // Decode the filtered color instead, retaining geometry at the midpoint.
    expect(dyeIdFromFlags(0.75, 0.25, 0.25, ops)).toBe(1);
    expect(dyeIdFromFlags(0.5, 0.5, 0.5, ops)).toBe(-1);
    expect(dyeIdFromFlags(0.25, 0.75, 0.75, ops)).toBe(4);
  });

  it.each([
    ["black", [0, 0, 0], 0], ["red", [255, 0, 0], 2],
    ["green", [0, 255, 0], 3], ["yellow", [255, 255, 0], 4],
    ["blue", [0, 0, 255], 5], ["magenta", [255, 0, 255], 2],
    ["cyan", [0, 255, 255], 5], ["white", [255, 255, 255], 6],
  ])("decodes %s without blending material parameters", (_, rgb, code) => {
    expect(Array.from(pixel([...rgb, 255]))).toEqual([code, 0, 0, code ? 255 : 0]);
  });

  it("uses authored half-range thresholds and ignores uncovered texels", () => {
    expect(pixel([127, 127, 127, 255])[3]).toBe(0);
    expect(pixel([128, 128, 128, 255])[0]).toBe(6);
    expect(pixel([255, 255, 255, 127])[3]).toBe(0);
    expect(pixel([255, 255, 255, 128])[0]).toBe(6);
  });

  it("corrects the atlas canvas without moving or stretching placements", () => {
    const raw = { size: [512, 512] as [number, number], placements: [
      { name: "a", x: 64, y: 32, w: 32, h: 16 },
    ] };
    const plate = dyeSlotPlate(raw);
    expect(plate.size).toEqual([128, 128]);
    expect(plate.placements).toEqual(raw.placements);
    expect(raw.size).toEqual([512, 512]);
    const atlas: RgbaImage = { width: 128, height: 128, data: new Uint8Array(128 * 128 * 4) };
    placeDataTile(atlas, { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }, 64, 32, 32, 16);
    const decoded = decodeDyeSlotMap(atlas);
    const at = (u: number, v: number) => decoded.data[(Math.floor(v * 128) * 128 + Math.floor(u * 128)) * 4];
    expect(at(0.5, 0.25)).toBe(2);
    expect(at(0.74, 0.37)).toBe(2);
    expect(at(0.49, 0.25)).toBe(0);
    expect(at(0.75, 0.25)).toBe(0);
    expect(at(0.5, 0.38)).toBe(0);
  });

  it("rejects invalid canvas dimensions instead of misplacing tiles", () => {
    expect(() => dyeSlotPlate({ size: [3, 4], placements: [] })).toThrow();
    expect(() => dyeSlotPlate({ size: [513, 512], placements: [] })).toThrow();
    expect(() => dyeSlotPlate({ size: [512, 512], placements: [
      { name: "unsupported-layout", x: 0, y: 0, w: 512, h: 512 },
    ] })).toThrow();
  });

  it("aligns Iron Companion Plate's real dye map with its diffuse and gearstack", () => {
    const plates = parseRenderMetadata(JSON.stringify(iron)).plates!;
    const plate = dyeSlotPlate(plates.dyeslot!);
    expect(plate.size).toEqual([128, 128]);
    const p = plate.placements[0], diffuse = plates.diffuse!;
    expect([p.x / 128, p.y / 128, p.w / 128, p.h / 128]).toEqual([
      diffuse.placements[0].x / diffuse.size[0], diffuse.placements[0].y / diffuse.size[1],
      diffuse.placements[0].w / diffuse.size[0], diffuse.placements[0].h / diffuse.size[1],
    ]);
    const source = decodeDataPng(Buffer.from(iron.png, "base64"));
    const atlas: RgbaImage = { width: 128, height: 128, data: new Uint8Array(128 * 128 * 4) };
    placeDataTile(atlas, source, p.x, p.y, p.w, p.h);
    const decoded = decodeDyeSlotMap(atlas), counts: Record<number, number> = {};
    for (let i = 0; i < source.width * source.height; i++) {
      const id = decoded.data[i * 4] - 1;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts).toEqual(iron.expectedOverrideTexels);
    expect(decoded.data.slice(source.data.length).every((v) => v === 0)).toBe(true);
  });
});

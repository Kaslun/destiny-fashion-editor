import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { decodeDataPng, placeDataTile } from "./dataTexture";
import { readFileSync } from "node:fs";

function png(scanlines: number[], width = 1, height = 1, type = 6) {
  const data = zlibSync(new Uint8Array(scanlines));
  const bytes = new Uint8Array(33 + 12 + data.length + 12);
  const view = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]);
  view.setUint32(8,13); view.setUint32(12,0x49484452);
  view.setUint32(16,width); view.setUint32(20,height); bytes[24]=8; bytes[25]=type;
  view.setUint32(33,data.length); view.setUint32(37,0x49444154); bytes.set(data,41);
  view.setUint32(45+data.length,0); view.setUint32(49+data.length,0x49454e44);
  return bytes;
}

describe("lossless material data loading", () => {
  it("loads the reference iridescence rows without reversing them or premultiplying alpha", () => {
    const image = decodeDataPng(readFileSync(new URL("../../public/textures/iridescence-lookup.png", import.meta.url)));
    expect([image.width, image.height]).toEqual([64, 128]);
    expect([...image.data.slice(0, 4)]).toEqual([133, 218, 238, 135]);
    expect([...image.data.slice(64 * 4, 64 * 4 + 4)]).toEqual([45, 75, 81, 245]);
    // Unused rows have a debug magenta color but zero coverage.
    expect([...image.data.slice(124 * 64 * 4, 124 * 64 * 4 + 4)]).toEqual([255, 0, 255, 0]);
  });
  it("retains RGB at zero and low alpha instead of compositing it as transparency", () => {
    const pixels = [255,123,32,0, 77,195,215,1, 21,31,41,32];
    expect([...decodeDataPng(png([0,...pixels],3)).data]).toEqual(pixels);
  });
  it.each([0,1,2,3,4])("decodes PNG scanline filter %i without changing channel values", (filter) => {
    // First pixel in the first row has a zero predictor for every filter.
    expect([...decodeDataPng(png([filter,17,34,51,0])).data]).toEqual([17,34,51,0]);
  });
  it("reconstructs left/above/upper-left predictors", () => {
    for (const [filter,encoded] of [[1,[10,20,30,40]],[2,[20,30,40,50]],[3,[15,25,35,45]],[4,[10,20,30,40]]] as const) {
      const image=decodeDataPng(png([0,10,20,30,40,20,30,40,50, filter,30,50,70,90,...encoded],2,2));
      // Row-two first pixel also uses the filter's above predictor.
      const row2=image.data.slice(8);
      expect(row2.length).toBe(8);
      if(filter===1) expect([...row2]).toEqual([30,50,70,90,40,70,100,130]);
      if(filter===2) expect([...row2]).toEqual([40,70,100,130,40,60,80,100]);
      if(filter===3) expect([...row2]).toEqual([35,60,85,110,42,70,97,125]);
      if(filter===4) expect([...row2]).toEqual([40,70,100,130,50,90,130,170]);
    }
  });
  it("copies tile bytes at their own atlas coordinates without blending neighboring slots", () => {
    const atlas={width:3,height:1,data:new Uint8Array(12).fill(200)};
    placeDataTile(atlas,{width:2,height:1,data:new Uint8Array([255,64,32,0, 9,8,7,255])},1,0,2,1);
    expect([...atlas.data]).toEqual([200,200,200,200,255,64,32,0,9,8,7,255]);
  });
  it("expands RGB data and rejects unsupported/truncated encodings", () => {
    expect([...decodeDataPng(png([0,10,20,30],1,1,2)).data]).toEqual([10,20,30,255]);
    expect(()=>decodeDataPng(new Uint8Array(10))).toThrow();
    expect(()=>decodeDataPng(png([5,0,0,0,0]))).toThrow();
  });
});

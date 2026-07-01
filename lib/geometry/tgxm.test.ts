import { describe, it, expect } from "vitest";
import { parseTgxm, fileAsText, findRenderMetadata } from "./tgxm";

const NAME_LEN = 256;
const FILE_ENTRY_LEN = NAME_LEN + 16; // name + offset + type + size + reserved

/** Build a minimal valid TGXM container with the given files. */
function makeContainer(files: { name: string; content: Uint8Array }[]): ArrayBuffer {
  const headerLen = 16 + NAME_LEN;
  const tableLen = files.length * FILE_ENTRY_LEN;
  const dataLen = files.reduce((n, f) => n + f.content.length, 0);
  const total = headerLen + tableLen + dataLen;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) bytes[offset + i] = str.charCodeAt(i);
  };

  // header
  writeStr(0, "TGXM");
  view.setUint32(4, 42, true); // version
  const fileTableOffset = headerLen;
  view.setUint32(8, fileTableOffset, true);
  view.setUint32(12, files.length, true);
  writeStr(16, "test-archive");

  // file data goes after the table
  let dataCursor = headerLen + tableLen;
  files.forEach((f, i) => {
    const entry = fileTableOffset + i * FILE_ENTRY_LEN;
    writeStr(entry, f.name);
    view.setUint32(entry + NAME_LEN, dataCursor, true); // offset
    view.setUint32(entry + NAME_LEN + 4, 0, true); // type
    view.setUint32(entry + NAME_LEN + 8, f.content.length, true); // size
    bytes.set(f.content, dataCursor);
    dataCursor += f.content.length;
  });

  return buf;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseTgxm", () => {
  it("parses header and file table", () => {
    const buf = makeContainer([
      { name: "render_metadata.js", content: enc('{"hello":1}') },
      { name: "0.indexbuffer.tgx", content: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const c = parseTgxm(buf);
    expect(c.version).toBe(42);
    expect(c.identifier).toBe("test-archive");
    expect(c.files).toHaveLength(2);
    expect(c.byName.has("render_metadata.js")).toBe(true);
    expect(c.byName.has("0.indexbuffer.tgx")).toBe(true);
  });

  it("slices file data at the correct offsets", () => {
    const buf = makeContainer([
      { name: "a.tgx", content: new Uint8Array([9, 8, 7]) },
      { name: "b.tgx", content: new Uint8Array([1, 2]) },
    ]);
    const c = parseTgxm(buf);
    expect([...c.byName.get("a.tgx")!.data]).toEqual([9, 8, 7]);
    expect([...c.byName.get("b.tgx")!.data]).toEqual([1, 2]);
  });

  it("finds and decodes render_metadata", () => {
    const buf = makeContainer([
      { name: "render_metadata.js", content: enc('{"render_meshes":[]}') },
    ]);
    const c = parseTgxm(buf);
    const meta = findRenderMetadata(c);
    expect(meta).not.toBeNull();
    expect(JSON.parse(fileAsText(meta!))).toEqual({ render_meshes: [] });
  });

  it("throws on bad magic", () => {
    const buf = new ArrayBuffer(300);
    expect(() => parseTgxm(buf)).toThrow(/TGXM/);
  });
});

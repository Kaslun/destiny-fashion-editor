/**
 * TGXM container parser.
 *
 * Bungie packs geometry and texture assets into a simple ".tgxm" archive. The
 * format is stable and well understood (this is the same container Bungie's own
 * Spasm library reads):
 *
 *   Header (little-endian):
 *     0x00  char[4]    magic  "TGXM"
 *     0x04  uint32     version
 *     0x08  uint32     fileTableOffset
 *     0x0C  uint32     fileCount
 *     0x10  char[256]  identifier (archive name)
 *
 *   File table (fileCount entries, starting at fileTableOffset), each 0x110:
 *     +0x00  char[256]  name
 *     +0x100 uint32     offset   (from start of container)
 *     +0x104 uint32     type     (always 0)
 *     +0x108 uint32     size
 *     +0x10C uint32     reserved (padding)
 *
 * A geometry container holds e.g. `0.0.vertexbuffer.tgx`,
 * `0.1.vertexbuffer.tgx`, `0.indexbuffer.tgx`, `render_metadata.js`.
 */

export interface TgxmFile {
  name: string;
  type: number;
  offset: number;
  size: number;
  data: Uint8Array;
}

export interface TgxmContainer {
  version: number;
  identifier: string;
  files: TgxmFile[];
  byName: Map<string, TgxmFile>;
}

const MAGIC = "TGXM";
const NAME_LEN = 256;
// name[256] + offset(u32) + type(u32) + size(u32) + reserved(u32)
const FILE_ENTRY_LEN = NAME_LEN + 16;

function readFixedString(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

export function parseTgxm(buffer: ArrayBuffer): TgxmContainer {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const magic = readFixedString(view, 0, 4);
  if (magic !== MAGIC) {
    throw new Error(`Not a TGXM container (magic="${magic}")`);
  }

  const version = view.getUint32(4, true);
  const fileTableOffset = view.getUint32(8, true);
  const fileCount = view.getUint32(12, true);
  const identifier = readFixedString(view, 16, NAME_LEN);

  const files: TgxmFile[] = [];
  const byName = new Map<string, TgxmFile>();

  for (let i = 0; i < fileCount; i++) {
    const base = fileTableOffset + i * FILE_ENTRY_LEN;
    const name = readFixedString(view, base, NAME_LEN);
    const offset = view.getUint32(base + NAME_LEN, true);
    const type = view.getUint32(base + NAME_LEN + 4, true);
    const size = view.getUint32(base + NAME_LEN + 8, true);

    const data = bytes.subarray(offset, offset + size);
    const file: TgxmFile = { name, type, offset, size, data };
    files.push(file);
    byName.set(name, file);
  }

  return { version, identifier, files, byName };
}

/** Decode a container file's bytes as UTF-8 text (for `render_metadata.js`). */
export function fileAsText(file: TgxmFile): string {
  return new TextDecoder("utf-8").decode(file.data);
}

/** Find the single `render_metadata.js` entry (name may vary slightly). */
export function findRenderMetadata(container: TgxmContainer): TgxmFile | null {
  return (
    container.byName.get("render_metadata.js") ??
    container.files.find((f) => f.name.includes("render_metadata")) ??
    null
  );
}

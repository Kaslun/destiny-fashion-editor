const ROOT = "https://www.bungie.net";
const TYPES: Record<string, string> = {
  tgxm: "application/octet-stream", bin: "application/octet-stream",
  js: "application/json", json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

/** Validate the normalized destination, for both initial requests and redirects. */
export function assetTarget(raw: string) {
  if (!raw || raw.length > 4096 || /[\\\s\u0000-\u001f]/.test(raw)) throw new Error("Invalid asset URL");
  if (!raw.startsWith("/common/") && !raw.startsWith("https://")) throw new Error("Unsupported asset URL");
  const url = new URL(raw, ROOT);
  if (url.protocol !== "https:" || !["www.bungie.net", "bungie.net"].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash) throw new Error("Unsupported asset origin");
  // Bungie asset names need no escaped path separators or double decoding.
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith("/common/") || !/^\/[a-zA-Z0-9_./-]+$/.test(pathname) ||
      pathname.split("/").some((part) => part === "." || part === "..") ||
      /%2f|%5c/i.test(url.pathname)) throw new Error("Unsupported asset path");
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  if (!Object.hasOwn(TYPES, ext)) throw new Error("Unsupported asset type");
  const file = pathname.split("/").pop()!;
  const immutable = !url.search && /(?:^|[_-])[a-f0-9]{32,64}(?=[._-]|$)/i.test(file);
  return { url: ROOT + pathname + url.search, contentType: TYPES[ext],
    cacheControl: immutable ? "public, max-age=31536000, immutable" : "public, max-age=300" };
}

export function safeAssetContent(expected: string, upstream: string | null) {
  const mime = upstream?.split(";", 1)[0].trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") return true;
  if (expected.startsWith("image/")) return mime === expected;
  // Gear .js is JSON data, never executable JavaScript in this origin.
  if (expected === "application/json") return ["application/json", "application/javascript", "text/javascript", "text/plain"].includes(mime);
  return !["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript"].includes(mime);
}

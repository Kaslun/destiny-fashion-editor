import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/bungie/client", () => ({ bungieFetchRaw: vi.fn() }));
import { bungieFetchRaw } from "@/lib/bungie/client";
import { GET } from "./route";

const request = (path: string) => new NextRequest(`http://localhost/api/asset?path=${encodeURIComponent(path)}`);
beforeEach(() => vi.mocked(bungieFetchRaw).mockReset());

it.each([
  "/Platform/Destiny2/Manifest/", "https://www.bungie.net/en/example.png",
  "https://evil.example/common/a.png", "http://www.bungie.net/common/a.png",
  "https://www.bungie.net:444/common/a.png", "https://user@www.bungie.net/common/a.png",
  "/common/../en/a.png", "/common/%2e%2e/en/a.png", "/common/%252e%252e/en/a.png",
  "/common/a%2fb.png", "/common/a.svg", "//evil.example/common/a.png",
])("rejects unsupported target %s before making any upstream request", async (path) => {
  expect((await GET(request(path))).status).toBe(403);
  expect(bungieFetchRaw).not.toHaveBeenCalled();
});

it("serves hashed images with safe types and immutable caching", async () => {
  vi.mocked(bungieFetchRaw).mockResolvedValue(new Response("image", { headers: { "content-type": "image/png" } }));
  const res = await GET(request("https://bungie.net/common/icons/0123456789abcdef0123456789abcdef.png"));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("immutable");
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(bungieFetchRaw).toHaveBeenCalledWith(expect.stringContaining("https://www.bungie.net/common/"), expect.objectContaining({ redirect: "manual" }));
  await res.text();
});

it("serves gear JavaScript files as non-executable data without immutable caching for unversioned URLs", async () => {
  vi.mocked(bungieFetchRaw).mockResolvedValue(new Response("{}", { headers: { "content-type": "application/javascript" } }));
  const res = await GET(request("/common/gear/example.js?version=current"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).not.toContain("immutable");
  expect(await res.text()).toBe("{}");
});

it("rejects redirects outside the allowlist without requesting their destination", async () => {
  vi.mocked(bungieFetchRaw).mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example/a.png" } }));
  expect((await GET(request("/common/a.png"))).status).toBe(502);
  expect(bungieFetchRaw).toHaveBeenCalledTimes(1);
});

it("follows safe redirects with a short cache policy", async () => {
  vi.mocked(bungieFetchRaw)
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/common/b.png" } }))
    .mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/png" } }));
  const res = await GET(request("/common/a.png"));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).not.toContain("immutable");
  await res.text();
});

it("rejects HTML masquerading as an image and sanitizes transport failures", async () => {
  vi.mocked(bungieFetchRaw).mockResolvedValueOnce(new Response("<script>bad</script>", { headers: { "content-type": "text/html" } }));
  expect((await GET(request("/common/a.png"))).status).toBe(502);
  vi.mocked(bungieFetchRaw).mockRejectedValueOnce(new Error("private server details"));
  const res = await GET(request("/common/a.png"));
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain("private server details");
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionService, sessionKey, type SessionData } from "./session";
import { RedisSessionStore, type SessionStore } from "./sessionStore";

function fixture() {
  const records = new Map<string, string>();
  const store: SessionStore = {
    get: async (key) => records.get(key) ?? null,
    set: async (key, value) => { records.set(key, value); },
    delete: async (key) => { records.delete(key); },
    compareAndSet: async (key, old, value) => {
      if (records.get(key) !== old) return false;
      records.set(key, value); return true;
    },
  };
  const service = new SessionService(store, "test-secret-only-0123456789-abcdef-0123456789");
  const data: SessionData = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    accessExpiresAt: Date.now() + 3600_000, refreshExpiresAt: Date.now() + 86_400_000, bungieMembershipId: "test" };
  return { records, store, service, data };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("opaque encrypted sessions", () => {
  it("keeps tokens out of both cookie IDs and stored plaintext", async () => {
    const { records, service, data } = fixture();
    const id = await service.create(data);
    expect(id).toMatch(/^s2_[a-f0-9]{64}$/);
    const stored = [...records.values()][0];
    expect(stored).not.toContain(data.accessToken);
    expect(stored).not.toContain(data.refreshToken);
    expect((await service.read(id))?.data).toEqual(data);
    expect(await service.read(Buffer.from(JSON.stringify(data)).toString("base64url") + ".signature")).toBeNull();
    expect(await service.read(id.slice(0, -1) + "z")).toBeNull();
  });
  it("rejects tampered ciphertext and records transplanted to another session", async () => {
    const { records, service, data } = fixture();
    const a = await service.create(data), b = await service.create(data);
    const encrypted = records.get(sessionKey(a))!;
    records.set(sessionKey(b), encrypted);
    expect(await service.read(b)).toBeNull();
    const bytes = encrypted.split(".");
    bytes[2] = (bytes[2][0] === "A" ? "B" : "A") + bytes[2].slice(1);
    records.set(sessionKey(a), bytes.join("."));
    expect(await service.read(a)).toBeNull();
  });
  it("enforces expiry even if a store retains the record", async () => {
    vi.useFakeTimers();
    const { service, data } = fixture();
    const id = await service.create(data);
    vi.setSystemTime(Date.now() + 86_400_001);
    expect(await service.read(id)).toBeNull();
  });
  it("does not resurrect logout or allow an older update to overwrite a newer one", async () => {
    const { service, data } = fixture();
    const id = await service.create(data);
    const old = (await service.read(id))!;
    expect(await service.update(old, { ...data, accessToken: "new-access" })).toBe(true);
    expect(await service.update(old, data)).toBe(false);
    const latest = (await service.read(id))!;
    await service.revoke(id);
    expect(await service.update(latest, data)).toBe(false);
    expect(await service.read(id)).toBeNull();
  });
  it("uses atomic conditional writes with TTLs and safe Redis requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 1 })));
    vi.stubGlobal("fetch", fetcher);
    const store = new RedisSessionStore("https://redis.example", "test-only-token");
    expect(await store.compareAndSet("key", "old", "new", 1234)).toBe(true);
    const init = fetcher.mock.calls[0][1];
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body)).toEqual(["EVAL", expect.stringContaining("redis.call('GET'"), 1, "key", "old", "new", 1234]);
    expect(() => new RedisSessionStore("http://redis.example", "test")).toThrow("HTTPS");
  });
});

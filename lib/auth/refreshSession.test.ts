import { afterEach, expect, it, vi } from "vitest";
import { SessionService, type SessionData } from "./session";
import type { SessionStore } from "./sessionStore";
import { SessionRefresher, SessionUnavailable, TokenRequestError } from "./refreshSession";

async function fixture() {
  const records = new Map<string, string>();
  const store: SessionStore = {
    get: async (key) => records.get(key) ?? null,
    set: async (key, value) => { records.set(key, value); },
    delete: async (key) => { records.delete(key); },
    compareAndSet: async (key, expected, value) => {
      if (records.get(key) !== expected) return false;
      records.set(key, value); return true;
    },
  };
  const secret = "synthetic-secret-0123456789-0123456789";
  const service = new SessionService(store, secret);
  const old: SessionData = { accessToken: "old", refreshToken: "refresh", accessExpiresAt: Date.now() - 1,
    refreshExpiresAt: Date.now() + 86_400_000, bungieMembershipId: "member" };
  const fresh = { ...old, accessToken: "new", refreshToken: "rotated", accessExpiresAt: Date.now() + 3600_000 };
  const id = await service.create(old);
  return { service, replica: new SessionService(store, secret), id, fresh };
}
afterEach(() => vi.useRealTimers());

it("coalesces concurrent requests locally and across server instances", async () => {
  const { service, replica, id, fresh } = await fixture();
  const refresh = vi.fn(async () => fresh);
  const a = new SessionRefresher(service, refresh), b = new SessionRefresher(replica, refresh);
  const results = await Promise.all([a.get(id), a.get(id), b.get(id)]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(results.every((r) => r?.accessToken === "new")).toBe(true);
});
it("persists rotation before dependent profile failure and never needs a response cookie", async () => {
  const { service, id, fresh } = await fixture();
  const refresh = vi.fn(async () => fresh);
  const resolver = new SessionRefresher(service, refresh);
  await expect((async () => {
    await resolver.get(id);
    throw new Error("profile failed");
  })()).rejects.toThrow("profile failed");
  expect((await service.read(id))?.data.refreshToken).toBe("rotated");
  expect((await resolver.get(id))?.accessToken).toBe("new");
  expect(refresh).toHaveBeenCalledTimes(1);
});
it("cannot restore a session logged out during refresh", async () => {
  const { service, id, fresh } = await fixture();
  const refresh = vi.fn(async () => { await service.revoke(id); return fresh; });
  expect(await new SessionRefresher(service, refresh).get(id)).toBeNull();
  expect(await service.read(id)).toBeNull();
});
it("distinguishes explicit transient failures from rejected authorization", async () => {
  const { service, id, fresh } = await fixture();
  const refresh = vi.fn().mockRejectedValueOnce(new TokenRequestError(false, true)).mockResolvedValue(fresh);
  const resolver = new SessionRefresher(service, refresh);
  await expect(resolver.get(id)).rejects.toBeInstanceOf(SessionUnavailable);
  expect((await service.read(id))?.refreshStartedAt).toBeUndefined();
  expect((await resolver.get(id))?.accessToken).toBe("new");
  const second = await fixture();
  const rejected = new SessionRefresher(second.service, async () => { throw new TokenRequestError(true, false); });
  expect(await rejected.get(second.id)).toBeNull();
  expect(await second.service.read(second.id)).toBeNull();
});
it("never replays a refresh token after an uncertain/crashed exchange", async () => {
  vi.useFakeTimers();
  const { service, id } = await fixture();
  const refresh = vi.fn(async () => { throw new Error("transport failed"); });
  const resolver = new SessionRefresher(service, refresh);
  await expect(resolver.get(id)).rejects.toBeInstanceOf(SessionUnavailable);
  expect((await service.read(id))?.refreshStartedAt).toBeTypeOf("number");
  vi.setSystemTime(Date.now() + 60_001);
  expect(await resolver.get(id)).toBeNull();
  expect(refresh).toHaveBeenCalledTimes(1);
});

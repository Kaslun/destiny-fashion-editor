import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { env } from "../env";

export interface SessionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  compareAndSet(key: string, expected: string, value: string, ttlMs: number): Promise<boolean>;
}

/** Development-only persistent store. Production uses shared Redis below. */
export class FileSessionStore implements SessionStore {
  private pending = new Map<string, Promise<unknown>>();
  constructor(private directory: string) {}
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    this.pending.set(key, run);
    try { return await run; } finally {
      if (this.pending.get(key) === run) this.pending.delete(key);
    }
  }
  private file(key: string) { return path.join(this.directory, createHash("sha256").update(key).digest("hex") + ".json"); }
  async get(key: string) {
    try {
      const entry = JSON.parse(await fs.readFile(this.file(key), "utf8"));
      if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) return null;
      return typeof entry.value === "string" ? entry.value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  set(key: string, value: string, ttlMs: number) {
    return this.locked(key, () => this.write(key, value, ttlMs));
  }
  private async write(key: string, value: string, ttlMs: number) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(key), temporary = target + "." + randomUUID();
    try {
      await fs.writeFile(temporary, JSON.stringify({ value, expiresAt: Date.now() + ttlMs }), { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  delete(key: string) { return this.locked(key, () => fs.rm(this.file(key), { force: true })); }
  async compareAndSet(key: string, expected: string, value: string, ttlMs: number) {
    return this.locked(key, async () => {
      if (await this.get(key) !== expected) return false;
      await this.write(key, value, ttlMs);
      return true;
    });
  }
}

/** Redis HTTPS REST protocol: https://upstash.com/docs/redis/features/restapi */
export class RedisSessionStore implements SessionStore {
  constructor(private url: string, private token: string) {
    if (new URL(url).protocol !== "https:") throw new Error("Session Redis requires HTTPS");
  }
  async command<T>(...command: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("Session store unavailable");
    const body = await res.json();
    if (body.error) throw new Error("Session store command failed");
    return body.result as T;
  }
  get(key: string) { return this.command<string | null>("GET", key); }
  async set(key: string, value: string, ttlMs: number) { await this.command("SET", key, value, "PX", Math.max(1, Math.ceil(ttlMs))); }
  async delete(key: string) { await this.command("DEL", key); }
  async compareAndSet(key: string, expected: string, value: string, ttlMs: number) {
    return await this.command<number>("EVAL",
      "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('PSETEX',KEYS[1],ARGV[3],ARGV[2]); return 1 else return 0 end",
      1, key, expected, value, Math.max(1, Math.ceil(ttlMs))) === 1;
  }
}

let store: SessionStore | undefined;
export function getSessionStore(): SessionStore {
  if (store) return store;
  const config = env.sessionStore();
  store = config.redisUrl && config.redisToken
    ? new RedisSessionStore(config.redisUrl, config.redisToken)
    : new FileSessionStore(path.join(process.cwd(), "data", "sessions"));
  return store;
}

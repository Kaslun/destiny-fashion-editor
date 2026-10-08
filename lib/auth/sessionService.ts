/** Opaque browser IDs; authenticated encryption for server-side Bungie tokens. */
import crypto from "node:crypto";
import { env } from "../env";
import { getSessionStore, type SessionStore } from "./sessionStore";

export const SESSION_COOKIE = "d2session";
export const OAUTH_STATE_COOKIE = "d2oauth_state";
const LIFETIME = 90 * 24 * 60 * 60 * 1000;
const ID = /^s2_[a-f0-9]{64}$/;

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  bungieMembershipId: string;
}
export interface StoredSession {
  id: string;
  data: SessionData;
  expiresAt: number;
  version: string;
  refreshStartedAt?: number;
}
function valid(data: SessionData) {
  return data && typeof data.accessToken === "string" && typeof data.refreshToken === "string" &&
    typeof data.bungieMembershipId === "string" && Number.isFinite(data.accessExpiresAt) && Number.isFinite(data.refreshExpiresAt);
}
export function sessionKey(id: string) { return "dfe:session:" + crypto.createHash("sha256").update(id).digest("hex"); }

export class SessionService {
  private key: Buffer;
  constructor(readonly store: SessionStore, secret: string) {
    if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 random characters");
    this.key = crypto.createHash("sha256").update(secret).digest();
  }
  private seal(id: string, data: SessionData, expiresAt: number, refreshStartedAt?: number) {
    if (!valid(data)) throw new Error("Invalid session data");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(JSON.stringify({ data, expiresAt, refreshStartedAt }), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString("base64url")).join(".");
  }
  async create(data: SessionData) {
    const id = "s2_" + crypto.randomBytes(32).toString("hex");
    const expiresAt = Math.min(Date.now() + LIFETIME, data.refreshToken ? data.refreshExpiresAt : data.accessExpiresAt);
    if (expiresAt <= Date.now()) throw new Error("Cannot create an expired session");
    await this.store.set(sessionKey(id), this.seal(id, data, expiresAt), expiresAt - Date.now());
    return id;
  }
  async read(id: string | null | undefined): Promise<StoredSession | null> {
    if (!id || !ID.test(id)) return null; // reject legacy token-bearing cookies
    const value = await this.store.get(sessionKey(id));
    if (!value) return null;
    let payload: { data: SessionData; expiresAt: number; refreshStartedAt?: number };
    try {
      const parts = value.split(".");
      if (parts.length !== 3) return null;
      const [iv, tag, bytes] = parts.map((p) => Buffer.from(p, "base64url"));
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(tag);
      payload = JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8"));
    } catch { return null; }
    if (!payload || !valid(payload.data) || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
    if (payload.refreshStartedAt !== undefined && !Number.isFinite(payload.refreshStartedAt)) return null;
    return { id, ...payload, version: value };
  }
  /** Claim before using the rotating refresh token, across all server instances. */
  async claimRefresh(session: StoredSession): Promise<StoredSession | null> {
    if (session.refreshStartedAt !== undefined || session.expiresAt <= Date.now()) return null;
    const refreshStartedAt = Date.now();
    const version = this.seal(session.id, session.data, session.expiresAt, refreshStartedAt);
    const claimed = await this.store.compareAndSet(sessionKey(session.id), session.version, version, session.expiresAt - Date.now());
    return claimed ? { ...session, version, refreshStartedAt } : null;
  }
  async invalidate(session: StoredSession) {
    // Conditional invalidation cannot revoke credentials another request just saved.
    await this.store.compareAndSet(sessionKey(session.id), session.version, "", 1);
  }
  async update(session: StoredSession, data: SessionData): Promise<boolean> {
    const expiresAt = Math.min(session.expiresAt, data.refreshToken ? data.refreshExpiresAt : data.accessExpiresAt);
    if (expiresAt <= Date.now()) return false;
    return this.store.compareAndSet(sessionKey(session.id), session.version,
      this.seal(session.id, data, expiresAt), expiresAt - Date.now());
  }
  async revoke(id: string | null | undefined) {
    if (id && ID.test(id)) await this.store.delete(sessionKey(id));
  }
}

let service: SessionService | undefined;
export function sessions() { return service ??= new SessionService(getSessionStore(), env.sessionSecret()); }
export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: LIFETIME / 1000 };
}

import { SessionService, type SessionData } from "./session";

/** An explicit OAuth rejection is different from temporary server/transport failure. */
export class TokenRequestError extends Error {
  constructor(readonly invalidGrant: boolean, readonly retryable: boolean) {
    super(invalidGrant ? "Authorization expired; sign in again" : "Authorization service temporarily unavailable");
  }
}
export class SessionUnavailable extends Error {
  constructor() { super("Session refresh temporarily unavailable; retry shortly"); }
}

export class SessionRefresher {
  private pending = new Map<string, Promise<SessionData | null>>();
  constructor(private service: SessionService, private refresh: (token: string) => Promise<SessionData>,
    private pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100))) {}

  get(id: string): Promise<SessionData | null> {
    const running = this.pending.get(id);
    if (running) return running;
    const request = this.resolve(id).finally(() => { this.pending.delete(id); });
    this.pending.set(id, request);
    return request;
  }

  private async resolve(id: string): Promise<SessionData | null> {
    const deadline = Date.now() + 20_000;
    while (true) {
      const session = await this.service.read(id);
      if (!session) return null;
      const data = session.data;
      if (Date.now() < data.accessExpiresAt - 30_000) return data;
      if (!data.refreshToken || Date.now() >= data.refreshExpiresAt) return null;
      if (session.refreshStartedAt !== undefined) {
        if (Date.now() - session.refreshStartedAt > 60_000) {
          // A crashed/uncertain refresh may already have rotated the remote token.
          // Never replay that token just because a lock timed out.
          await this.service.invalidate(session);
          return null;
        }
        if (Date.now() >= deadline) throw new SessionUnavailable();
        await this.pause();
        continue;
      }
      const claimed = await this.service.claimRefresh(session);
      if (!claimed) {
        if (Date.now() >= deadline) throw new SessionUnavailable();
        continue;
      }
      let fresh: SessionData;
      try {
        fresh = await this.refresh(data.refreshToken);
      } catch (error) {
        if (error instanceof TokenRequestError && error.invalidGrant) {
          await this.service.invalidate(claimed);
          return null;
        }
        // Only explicit retryable HTTP errors release the claim. Transport failures
        // have unknown remote outcome, so preserve the claim and avoid token reuse.
        if (error instanceof TokenRequestError && error.retryable) await this.service.update(claimed, data);
        throw new SessionUnavailable();
      }
      if (!fresh.bungieMembershipId) fresh.bungieMembershipId = data.bungieMembershipId;
      // Persist before any profile work. No response cookie update is needed.
      if (!await this.service.update(claimed, fresh)) return null; // e.g. logout during refresh
      return fresh;
    }
  }
}

// SPDX-License-Identifier: MPL-2.0

/**
 * #969 — how Firebase Hosting decides when a channel is deleted, as the
 * live v1beta1 API behaves (probed read-only against a gcp-firebase install
 * on 2026-10-21), shared by every fake Firebase in the test suite so none
 * of them can drift back to the behaviour #908 assumed:
 *
 *   - a preview channel always carries an `expireTime` (create with `ttl`
 *     sets it to now + ttl; the live channel lists `expireTime: null`);
 *   - `PATCH …?updateMask=ttl` with `{ ttl }` moves it to now + ttl and
 *     answers with the channel, `expireTime` included;
 *   - `PATCH …?updateMask=expireTime` with `{ expireTime: null }` — the
 *     "never expires" clear #909 shipped — is refused with the 400 below.
 */

/** The error body the live API answered #909's expireTime clear with (issue #969). */
export const FIREBASE_EXPIRE_TIME_CLEAR_REFUSED = {
  error: {
    code: 400,
    message:
      "Invalid mask/channel: mask included expire_time, while channel has no expire time assigned",
    status: "INVALID_ARGUMENT",
  },
} as const;

/** Parse a Firebase `google-duration` of whole seconds ("604800s"). */
function durationMs(ttl: unknown): number {
  const m = typeof ttl === "string" ? /^(\d+)s$/.exec(ttl) : null;
  if (!m) throw new Error(`fake firebase: unsupported ttl ${JSON.stringify(ttl)}`);
  return Number(m[1]) * 1000;
}

/** Per-channel expiry the way Firebase keeps it. */
export class FakeChannelLifetimes {
  /** The clock Firebase measures `ttl` from; tests move it to simulate idle time. */
  now: () => number = () => Date.now();
  /** A ttl PATCH carrying exactly this ttl answers 503, as a transient API failure would. */
  failTtl: string | null = null;
  /** Every ttl PATCH, in order: which channel got which ttl. */
  readonly ttlPatches: { channelId: string; ttl: string }[] = [];
  private readonly expireAt = new Map<string, number>();

  /** A preview channel created with `ttl` (Caelo always sends one). */
  create(channelId: string, ttl: unknown): void {
    this.expireAt.set(channelId, this.now() + durationMs(ttl));
  }

  /** Seed an expiry directly (a channel an earlier version left behind). */
  seed(channelId: string, expireAtMs: number): void {
    this.expireAt.set(channelId, expireAtMs);
  }

  forget(channelId: string): void {
    this.expireAt.delete(channelId);
  }

  /** The listed `expireTime`: ISO 8601 for a preview channel, null for live. */
  expireTime(channelId: string): string | null {
    if (channelId === "live") return null;
    const at = this.expireAt.get(channelId);
    if (at === undefined) throw new Error(`fake firebase: no expiry for channel ${channelId}`);
    return new Date(at).toISOString();
  }

  /** Milliseconds until the channel expires, from the fake's clock. */
  remainingMs(channelId: string): number {
    const at = this.expireAt.get(channelId);
    if (at === undefined) throw new Error(`fake firebase: no expiry for channel ${channelId}`);
    return at - this.now();
  }

  /** Answer a `PATCH sites/<site>/channels/<id>` exactly like the live API does. */
  patch(siteName: string, channelId: string, updateMask: string | null, body: unknown): Response {
    const parsed = (body ?? {}) as { ttl?: unknown; expireTime?: unknown };
    const mask = (updateMask ?? "").split(",").map((f) => f.trim());
    if (mask.includes("expireTime") || mask.includes("expire_time")) {
      if (parsed.expireTime === null || parsed.expireTime === undefined) {
        return new Response(JSON.stringify(FIREBASE_EXPIRE_TIME_CLEAR_REFUSED), { status: 400 });
      }
      throw new Error("fake firebase: Caelo never sets expireTime directly");
    }
    if (mask.length === 1 && mask[0] === "ttl") {
      const ttl = String(parsed.ttl);
      if (this.failTtl === ttl) return new Response('{"error":"unavailable"}', { status: 503 });
      this.expireAt.set(channelId, this.now() + durationMs(parsed.ttl));
      this.ttlPatches.push({ channelId, ttl });
      return new Response(
        JSON.stringify({
          name: `sites/${siteName}/channels/${channelId}`,
          expireTime: this.expireTime(channelId),
        }),
        { status: 200 },
      );
    }
    throw new Error(`fake firebase: unexpected channel patch ${updateMask} ${JSON.stringify(body)}`);
  }
}

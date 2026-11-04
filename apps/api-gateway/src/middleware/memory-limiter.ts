// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway's in-memory rate limiter (#1326, #763 M1/H5).
 *
 * The database rate limit (rate-limit.ts) costs a transaction with an
 * advisory lock and a row write per request, on the one small server every
 * environment shares. The cheap setup has no WAF in front (E3, `*.run.app`
 * stays reachable), so a flood would meet that limiter only after it
 * already cost the database. This token bucket per client runs before any
 * database access and sheds a flood for the price of a Map lookup.
 *
 * Per instance: Cloud Run may run several, each with its own buckets, so a
 * client gets at most `instances ×` this budget here — the database limit
 * stays the precise one; this one only keeps floods off the database. It is
 * keyed by the client's rate-limit address (IPv6 per /64, client-ip.ts),
 * never by anything the client can rotate.
 *
 * Bounded memory: at most `maxKeys` buckets. A full map first drops buckets
 * that refilled completely (they carry no state), then the least recently
 * used ones; a dropped bucket starts full again, which only ever favours
 * the client, never blocks one.
 */

/** A token bucket's shape: `capacity` requests at once, `refillPerSec` sustained. */
export interface MemoryLimitSpec {
  readonly capacity: number;
  readonly refillPerSec: number;
}

/** What a {@link MemoryRateLimiter.take} decided. */
export interface MemoryLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the next token, when not allowed. */
  readonly retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Token buckets per key, in memory, bounded to `maxKeys`. */
export class MemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly spec: MemoryLimitSpec,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take one token for `key`. */
  take(key: string): MemoryLimitDecision {
    const now = this.now();
    const found = this.buckets.get(key);
    const bucket = found ?? { tokens: this.spec.capacity, at: now };
    const refilled = Math.min(
      this.spec.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.spec.refillPerSec,
    );
    // Re-inserted on every touch: Map order is then least recently used first.
    this.buckets.delete(key);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, at: now });
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((1 - refilled) / this.spec.refillPerSec)),
      };
    }
    this.buckets.set(key, { tokens: refilled - 1, at: now });
    if (!found && this.buckets.size > this.maxKeys) this.evict(now);
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Whether `key` has a token left, without taking one (#1330: the staging
   * gate's failure budget is checked before the gate runs and spent only
   * by a refusal).
   */
  peek(key: string): MemoryLimitDecision {
    const found = this.buckets.get(key);
    if (!found) return { allowed: true, retryAfterSec: 0 };
    const refilled = Math.min(
      this.spec.capacity,
      found.tokens + ((this.now() - found.at) / 1000) * this.spec.refillPerSec,
    );
    return refilled >= 1
      ? { allowed: true, retryAfterSec: 0 }
      : {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((1 - refilled) / this.spec.refillPerSec)),
        };
  }

  /** Buckets held; for tests and the bound. */
  get size(): number {
    return this.buckets.size;
  }

  private evict(now: number): void {
    const fullAfterMs = (b: Bucket) =>
      ((this.spec.capacity - b.tokens) / this.spec.refillPerSec) * 1000;
    for (const [key, b] of this.buckets) {
      if (this.buckets.size <= this.maxKeys) return;
      if (now - b.at >= fullAfterMs(b)) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) return;
      this.buckets.delete(key);
    }
  }
}

/**
 * Every visitor request the gateway serves from the database (plugin
 * operations, captcha challenges), per client: a burst of 120, then 2 per
 * second. A page view makes a handful (auth `me`, a comment list, a rating);
 * a NAT or a CDN edge (gcp-firebase, client-ip.ts) adds many visitors up.
 * The database limits per operation stay far below this; this only stops
 * floods before they cost a transaction.
 */
export const VISITOR_MEMORY_LIMIT: MemoryLimitSpec = { capacity: 120, refillPerSec: 2 };

/**
 * Every visitor route's budget per operation (`slug.op`, or the captcha
 * challenge), whoever calls it: a burst of 300, then 5 per second per
 * instance. The per-client key cannot be the binding guard everywhere: on
 * gcp-firebase the only unforgeable address is a Google front-end proxy
 * that changes from request to request (docs/dev/firebase-hosting-behaviour.md,
 * #1325), so per-client buckets there are close to one per request. This
 * budget caps what any number of addresses together can make one operation
 * cost the database. It is keyed only after the operation was found to be
 * served (server.ts), so the map holds real operations only.
 */
export const OPERATION_MEMORY_LIMIT: MemoryLimitSpec = { capacity: 300, refillPerSec: 5 };

/**
 * The deep health check (`?deep=1`, health.ts) per client: it opens a
 * database round trip, and the upgrade probe calls it a few times a minute.
 */
export const DEEP_HEALTH_MEMORY_LIMIT: MemoryLimitSpec = { capacity: 10, refillPerSec: 0.2 };

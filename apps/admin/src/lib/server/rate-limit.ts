// SPDX-License-Identifier: MPL-2.0

/**
 * In-process per-key sliding-window rate limiter. Good enough for one admin
 * instance; P13 replaces this with a gateway-level limiter shared across
 * instances. Login is the only caller in P2.1.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

export class SlidingWindowLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #windowMs: number;
  readonly #limit: number;

  constructor(options: { windowMs: number; limit: number }) {
    this.#windowMs = options.windowMs;
    this.#limit = options.limit;
  }

  /** Returns true when the caller has attempts remaining. */
  consume(key: string, now: number = Date.now()): boolean {
    const existing = this.#buckets.get(key);
    if (!existing || now - existing.windowStart >= this.#windowMs) {
      this.#buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (existing.count >= this.#limit) return false;
    existing.count += 1;
    return true;
  }

  retryAfterMs(key: string, now: number = Date.now()): number {
    const existing = this.#buckets.get(key);
    if (!existing) return 0;
    return Math.max(0, this.#windowMs - (now - existing.windowStart));
  }

  /** Test-only reset. */
  reset(): void {
    this.#buckets.clear();
  }
}

/** Per-IP login limiter: 5 attempts per 5 minutes. */
export const loginLimiter = new SlidingWindowLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 5,
});

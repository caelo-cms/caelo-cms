// SPDX-License-Identifier: MPL-2.0

/**
 * Fixed-window rate limits, in memory. The intake runs as one instance
 * (Cloud Run max-instances=1), so one process sees every request; a
 * restart resets the windows, which is acceptable for abuse damping.
 */

export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** true = allowed (and counted); false = over the limit for this window. */
  take(key: string, nowMs: number): boolean {
    const w = this.#windows.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      this.#windows.set(key, { start: nowMs, count: 1 });
      this.#sweep(nowMs);
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }

  #sweep(nowMs: number): void {
    if (this.#windows.size < 10_000) return;
    for (const [k, w] of this.#windows) {
      if (nowMs - w.start >= this.windowMs) this.#windows.delete(k);
    }
  }
}

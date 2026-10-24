// SPDX-License-Identifier: MPL-2.0

/**
 * Coalesces a build's per-page progress into at most one write per
 * interval (#1003). The generator reports every page; written one by one
 * that was one database transaction per page — ~80 % of a Stage's SQL
 * statements, each a network round trip against Cloud SQL, competing with
 * every other admin request for pool connections.
 *
 * At most one write is in flight; whatever arrives meanwhile replaces the
 * pending value, so the newest state always lands last. `flush()` writes
 * the final state and resolves once nothing is in flight.
 */
export class ProgressThrottle<T> {
  readonly #write: (value: T) => Promise<unknown>;
  readonly #intervalMs: number;
  readonly #now: () => number;
  #pending: T | null = null;
  #inFlight: Promise<void> | null = null;
  #lastWriteAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param write persists one value; a rejection is swallowed (progress is
   *   advisory — a lost update must never fail the build it describes).
   * @param intervalMs minimum gap between two writes.
   */
  constructor(write: (value: T) => Promise<unknown>, intervalMs: number, now = () => Date.now()) {
    this.#write = write;
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  /** Record the newest value; written now if the interval allows, else later. */
  offer(value: T): void {
    this.#pending = value;
    this.#schedule();
  }

  /** Write whatever is pending immediately and wait until no write is in flight. */
  async flush(): Promise<void> {
    for (;;) {
      // A write finishing re-schedules the pending value behind a timer;
      // the flush writes it now instead.
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      if (this.#inFlight !== null) await this.#inFlight;
      else if (this.#pending !== null) this.#startWrite();
      else return;
    }
  }

  #schedule(): void {
    if (this.#inFlight !== null || this.#timer !== null) return;
    const wait = this.#lastWriteAt + this.#intervalMs - this.#now();
    if (wait <= 0) {
      this.#startWrite();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#startWrite();
    }, wait);
  }

  #startWrite(): void {
    if (this.#pending === null) return;
    const value = this.#pending;
    this.#pending = null;
    this.#lastWriteAt = this.#now();
    this.#inFlight = this.#write(value)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#inFlight = null;
        if (this.#pending !== null) this.#schedule();
      });
  }
}

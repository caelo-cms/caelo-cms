// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — where a browser still runs inside the admin (self-hosted and
 * dev installs), one render at a time. Every page a render opens costs the
 * process a renderer (hundreds of MB for a heavy page); several at once —
 * a crawl's four workers next to a chat screenshot — were how a 2 GiB admin
 * got OOM-killed. Callers queue instead, first come first served.
 */

/** A FIFO semaphore with `slots` permits. */
export interface CaptureSlots {
  /** Run `fn` once a permit is free; the permit is returned however `fn` ends. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Renders running now (for tests and the idle close). */
  readonly active: number;
}

export function createCaptureSlots(slots: number): CaptureSlots {
  if (!Number.isInteger(slots) || slots < 1)
    throw new Error(`capture slots must be ≥ 1, got ${slots}`);
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < slots) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    // Hand the permit straight to the next waiter: `active` stays the same.
    if (next) next();
    else active -= 1;
  };
  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
  };
}

/** The admin process's one in-process render slot. */
export const IN_PROCESS_CAPTURE_SLOTS = 1;

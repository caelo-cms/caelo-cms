// SPDX-License-Identifier: MPL-2.0

/**
 * Wall-clock timings of the steps of one long operation (a Stage: chat
 * merge, generator passes, upload, parity fingerprint, preview selection).
 * The generator subprocess and the admin share this shape, so the
 * generator's phases arrive in the admin's list prefixed and in order.
 *
 * Laps instead of wrapped callbacks: `lap("x")` closes the step that ran
 * since the previous lap, so a long function gets one line per boundary
 * and keeps its control flow (early throws, shared locals) as it is.
 *
 * #1271 — with `{ memory: true }` every step also carries the peak resident
 * memory of the process while it ran (`peakRssMb`): sampled every
 * {@link RSS_SAMPLE_MS} by one shared timer that runs only while a memory
 * timer is open ({@link PhaseTimer.close}), plus a reading at every lap.
 */

import { z } from "zod";

/** One finished step: its name and how long it took, in whole milliseconds. */
export const phaseTimingSchema = z.object({
  phase: z.string().min(1),
  ms: z.number().int().nonnegative(),
  /** #1271 — the process's peak resident memory during the step, in MiB. */
  peakRssMb: z.number().int().nonnegative().optional(),
});
export type PhaseTiming = z.infer<typeof phaseTimingSchema>;

/** How often the open memory timers sample the resident set. */
export const RSS_SAMPLE_MS = 25;

const MIB = 1024 * 1024;

function rssNow(): number {
  return typeof process !== "undefined" && typeof process.memoryUsage === "function"
    ? process.memoryUsage().rss
    : 0;
}

/**
 * The one sampler of this process: its timer runs while at least one memory
 * timer is open, and every open timer sees each sample.
 */
const sampler = (() => {
  const listeners = new Set<(rss: number) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    add(fn: (rss: number) => void): void {
      listeners.add(fn);
      if (timer === null) {
        timer = setInterval(() => {
          const rss = rssNow();
          for (const l of listeners) l(rss);
        }, RSS_SAMPLE_MS);
        // Never what keeps the process alive.
        (timer as { unref?: () => void }).unref?.();
      }
    },
    remove(fn: (rss: number) => void): void {
      listeners.delete(fn);
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
})();

export class PhaseTimer {
  readonly #now: () => number;
  readonly #phases: PhaseTiming[] = [];
  readonly #start: number;
  readonly #listener: ((rss: number) => void) | null;
  #last: number;
  #peak = 0;

  /**
   * @param now clock in milliseconds; injectable for tests.
   * @param opts.memory record each step's peak RSS (see the file header);
   *   the timer must then be {@link close}d.
   */
  constructor(now: () => number = () => performance.now(), opts: { memory?: boolean } = {}) {
    this.#now = now;
    this.#start = now();
    this.#last = this.#start;
    if (opts.memory) {
      this.#peak = rssNow();
      this.#listener = (rss) => {
        if (rss > this.#peak) this.#peak = rss;
      };
      sampler.add(this.#listener);
    } else {
      this.#listener = null;
    }
  }

  /** A timer that records peak RSS per step (`new PhaseTimer(undefined, { memory: true })`). */
  static withMemory(): PhaseTimer {
    return new PhaseTimer(undefined, { memory: true });
  }

  /** Close the step that ran since the previous lap (or construction) as `phase`. */
  lap(phase: string): void {
    const t = this.#now();
    this.#phases.push({
      phase,
      ms: Math.round(t - this.#last),
      ...this.#takePeak(),
    });
    this.#last = t;
  }

  /**
   * Close the step since the previous lap as several phases measured
   * inside it (`parts`, ms and peak each — e.g. the passes of every page
   * batch summed), plus `rest` for whatever of the step they do not cover.
   */
  lapParts(parts: ReadonlyMap<string, { ms: number; peakRssMb?: number }>, rest: string): void {
    const t = this.#now();
    const elapsed = t - this.#last;
    let covered = 0;
    for (const [phase, p] of parts) {
      covered += p.ms;
      this.#phases.push({
        phase,
        ms: Math.round(p.ms),
        ...(p.peakRssMb !== undefined ? { peakRssMb: p.peakRssMb } : {}),
      });
    }
    this.#phases.push({
      phase: rest,
      ms: Math.max(0, Math.round(elapsed - covered)),
      ...this.#takePeak(),
    });
    this.#last = t;
  }

  /**
   * Run `fn` and add its duration (and, for a memory timer, its peak RSS)
   * to `into[phase]` — for steps that repeat per batch, summed by
   * {@link lapParts}.
   */
  async measure<T>(
    into: Map<string, { ms: number; peakRssMb?: number }>,
    phase: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const peakBefore = this.#peak;
    if (this.#listener) this.#peak = rssNow();
    const t0 = this.#now();
    try {
      return await fn();
    } finally {
      const prev = into.get(phase) ?? { ms: 0 };
      const ms = prev.ms + (this.#now() - t0);
      if (this.#listener) {
        const peak = Math.max(this.#peak, rssNow());
        into.set(phase, { ms, peakRssMb: Math.max(prev.peakRssMb ?? 0, Math.round(peak / MIB)) });
        this.#peak = Math.max(peakBefore, peak);
      } else {
        into.set(phase, { ms });
      }
    }
  }

  /**
   * Append steps timed elsewhere (the generator subprocess, a publisher)
   * as `<prefix>.<phase>`. They ran inside the current lap, so the lap that
   * closes it still measures the whole span (the remainder is the overhead
   * around them, e.g. spawning the subprocess).
   */
  include(prefix: string, phases: readonly PhaseTiming[]): void {
    for (const p of phases) this.#phases.push({ ...p, phase: `${prefix}.${p.phase}` });
  }

  /** Milliseconds since construction. */
  totalMs(): number {
    return Math.round(this.#now() - this.#start);
  }

  /** The steps so far, in the order they finished. */
  phases(): PhaseTiming[] {
    return [...this.#phases];
  }

  /** Stop sampling memory (a memory timer must be closed; idempotent). */
  close(): void {
    if (this.#listener) sampler.remove(this.#listener);
  }

  /** The peak since the previous lap, then restart it from now. */
  #takePeak(): { peakRssMb?: number } {
    if (!this.#listener) return {};
    const peak = Math.max(this.#peak, rssNow());
    this.#peak = rssNow();
    return { peakRssMb: Math.round(peak / MIB) };
  }
}

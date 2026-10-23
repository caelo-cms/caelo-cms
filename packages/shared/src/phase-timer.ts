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
 */

import { z } from "zod";

/** One finished step: its name and how long it took, in whole milliseconds. */
export const phaseTimingSchema = z.object({
  phase: z.string().min(1),
  ms: z.number().int().nonnegative(),
});
export type PhaseTiming = z.infer<typeof phaseTimingSchema>;

export class PhaseTimer {
  readonly #now: () => number;
  readonly #phases: PhaseTiming[] = [];
  readonly #start: number;
  #last: number;

  /** @param now clock in milliseconds; injectable for tests. */
  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#start = now();
    this.#last = this.#start;
  }

  /** Close the step that ran since the previous lap (or construction) as `phase`. */
  lap(phase: string): void {
    const t = this.#now();
    this.#phases.push({ phase, ms: Math.round(t - this.#last) });
    this.#last = t;
  }

  /**
   * Append steps timed elsewhere (the generator subprocess, a publisher)
   * as `<prefix>.<phase>`. They ran inside the current lap, so the lap that
   * closes it still measures the whole span (the remainder is the overhead
   * around them, e.g. spawning the subprocess).
   */
  include(prefix: string, phases: readonly PhaseTiming[]): void {
    for (const p of phases) this.#phases.push({ phase: `${prefix}.${p.phase}`, ms: p.ms });
  }

  /** Milliseconds since construction. */
  totalMs(): number {
    return Math.round(this.#now() - this.#start);
  }

  /** The steps so far, in the order they finished. */
  phases(): PhaseTiming[] {
    return [...this.#phases];
  }
}

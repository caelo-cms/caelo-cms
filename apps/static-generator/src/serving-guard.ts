// SPDX-License-Identifier: MPL-2.0

/**
 * #1211 — a stopped build never leaves `current/` half-written.
 *
 * The admin stops a running generator with SIGTERM (the operator's Stop).
 * Until the build is mirrored into `<outDir>/current/` that is harmless:
 * nothing serves the build yet. The mirror (`syncContents`) overwrites
 * the served files in place and removes obsolete ones, so a kill in the
 * middle would leave the self-hosted staging serving a mix of two builds.
 * From the moment it starts, the build is being published: SIGTERM is
 * ignored and the generator finishes and reports `done`, which the admin
 * records as published.
 */

/** The bits of `process` the guard uses (a fake in the tests). */
export interface SignalTarget {
  on(signal: "SIGTERM", listener: () => void): unknown;
  exit(code: number): never;
}

/** Exit status of a process ended by SIGTERM (128 + 15). */
const SIGTERM_EXIT = 143;

/**
 * Install the SIGTERM handler: exit at once until {@link ServingGuard.markServing},
 * ignore the signal afterwards.
 */
export function installServingGuard(proc: SignalTarget): { markServing(): void } {
  let serving = false;
  proc.on("SIGTERM", () => {
    if (!serving) proc.exit(SIGTERM_EXIT);
  });
  return {
    markServing: () => {
      serving = true;
    },
  };
}

/** What {@link installServingGuard} returns. */
export type ServingGuard = ReturnType<typeof installServingGuard>;

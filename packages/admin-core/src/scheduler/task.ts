// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — what the scheduler tick runs.
 *
 * A {@link ScheduledTask} is one piece of periodic work with its own
 * cadence. The tick (tick.ts) runs every few minutes (the install knob
 * `schedulerIntervalMinutes`, 1–15) and runs each task whose due-table row
 * (migration 0550) says it is due, so a task's cadence is "at most this
 * often, at least once per tick after it is due".
 */

/**
 * How often a task runs.
 *
 * - `everySeconds`: an interval counted from the start of the previous run.
 *   `0` = every tick.
 * - `cron`: the next occurrence after a given time (a plugin worker's cron
 *   pattern, rounded up to the tick). `null` = the pattern has no further
 *   occurrence.
 */
export type TaskCadence =
  | { readonly everySeconds: number }
  | { readonly nextAfter: (from: Date) => Date | null };

/** One periodic task. */
export interface ScheduledTask {
  /** The due-table key: `core:<name>` or `plugin:<slug>/<worker>`. */
  readonly key: string;
  readonly cadence: TaskCadence;
  /**
   * How long one run may hold the task. A run still going when it expires
   * may be started again by another tick, so it bounds the run, too: the
   * tick stops waiting for a run after its lease.
   */
  readonly leaseSeconds: number;
  /**
   * Do the work once. Resolves with an optional one-line summary for the
   * tick's answer and logs; throws when the work failed (the message is
   * recorded on the task and the next run retries).
   */
  run(): Promise<string | undefined>;
}

/**
 * Interval tasks become due this much early, so a task with the tick's own
 * cadence is not skipped because the tick arrived a few seconds sooner than
 * the interval (Cloud Scheduler and container start jitter).
 */
export const TASK_DUE_SLACK_SECONDS = 60;

/** The lease of a task that names none: well past any tick's time budget. */
export const DEFAULT_TASK_LEASE_SECONDS = 10 * 60;

/** When a cron task with no further occurrence is looked at again. */
export const NO_OCCURRENCE_RECHECK_SECONDS = 24 * 60 * 60;

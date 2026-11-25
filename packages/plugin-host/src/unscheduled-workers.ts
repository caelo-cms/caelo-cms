// SPDX-License-Identifier: MPL-2.0

/**
 * #1728 — the workers this process keeps off the schedule, per plugin.
 *
 * The scheduler (`scheduler.ts`) writes it when it schedules a plugin; the
 * runtime record (`runtime-health.ts`) reads it into this server's
 * `plugin_runtime` row, which plugin health reports for as long as the row
 * is live. A module of its own, with no imports, because the runtime record
 * is part of the gateway's dispatch-only host too, and the scheduler brings
 * the plugin validator (oxc-parser) along, which the gateway image must not
 * contain (#1340, `scripts/service-image.test.ts`).
 */

/** A worker the scheduler could not register because croner refused its cron (#1720). */
export interface UnscheduledWorker {
  readonly workerName: string;
  readonly cron: string;
  /** croner's reason, e.g. "CronPattern: Invalid value for minute: 61". */
  readonly reason: string;
}

const byPlugin = new Map<string, ReadonlyArray<UnscheduledWorker>>();

/** Replace `slug`'s workers off the schedule; an empty list clears them. */
export function setUnscheduledWorkers(
  slug: string,
  workers: ReadonlyArray<UnscheduledWorker>,
): void {
  if (workers.length > 0) byPlugin.set(slug, [...workers]);
  else byPlugin.delete(slug);
}

/** `slug`'s workers off the schedule, as a copy; empty when every worker is registered. */
export function unscheduledWorkersOf(slug: string): ReadonlyArray<UnscheduledWorker> {
  return [...(byPlugin.get(slug) ?? [])];
}

/** Forget every plugin's (host shutdown, tests). */
export function clearUnscheduledWorkers(): void {
  byPlugin.clear();
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 category C — plugin workers on the scheduler tick.
 *
 * Every active plugin's `manifest.workers[]` (registered with the plugin
 * host when the plugin loads, plugin-host/scheduler.ts) becomes one task
 * `plugin:<slug>/<worker>` whose next due time is its cron's next
 * occurrence. The tick runs them on the platform level — one tick for all
 * plugins, never a timer per plugin — so a worker runs at its cron's
 * cadence rounded up to the tick (newsletter `drain_sends`, every minute,
 * runs every tick).
 */

import { pluginWorkerScheduler, type ScheduledWorker } from "@caelo-cms/plugin-host";
import { SCHEDULED_TASK_KEY } from "../ops/scheduled_tasks.js";
import type { ScheduledTask } from "./task.js";

/** A plugin worker's run may take this long before another tick may start it again. */
export const PLUGIN_WORKER_LEASE_SECONDS = 5 * 60;

/** The due-table key of a plugin worker. */
export function pluginWorkerTaskKey(w: Pick<ScheduledWorker, "pluginSlug" | "workerName">): string {
  return `plugin:${w.pluginSlug}/${w.workerName}`;
}

/**
 * The tasks of every active plugin worker this host loaded. A worker whose
 * name cannot be a due-table key (a `/` or a control character) is reported
 * through `log` and left out: it would otherwise never run without anyone
 * noticing.
 */
export function pluginWorkerTasks(
  workers: readonly ScheduledWorker[] = pluginWorkerScheduler.list(),
  log: (line: string) => void = (line) => console.error(line),
): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const w of workers) {
    if (!w.active) continue;
    const key = pluginWorkerTaskKey(w);
    if (!SCHEDULED_TASK_KEY.test(key)) {
      log(
        `[scheduler] plugin worker ${w.pluginSlug}/${w.workerName} does not run: its name cannot be a scheduler key (no "/" or control characters)`,
      );
      continue;
    }
    tasks.push({
      key,
      cadence: { nextAfter: (from) => w.nextAfter(from) },
      leaseSeconds: PLUGIN_WORKER_LEASE_SECONDS,
      run: async () => {
        await w.run();
        return undefined;
      },
    });
  }
  return tasks;
}

// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/scheduler — the registry of Tier-1 plugin workers.
 *
 * Plugins declare cron-style background jobs in `manifest.workers[]`:
 *
 *   workers: [
 *     { name: "job_runner", cron: "0 * * * * *", operationName: "_run_pending_units" }
 *   ]
 *
 * At plugin activation the host calls `pluginWorkerScheduler.schedule(...)`,
 * which REGISTERS each worker: its cron pattern (parsed with `croner`, the
 * same way the validator parses it) and a `run()` that invokes the plugin's
 * named operation via the dispatcher with system actor scope + the plugin's
 * actor row + caelo.plugin_id session vars set.
 *
 * #1720 — a pattern croner refuses keeps only that worker off the schedule.
 * The validator refuses such a pattern in every review, so only an artifact
 * approved under an older croner can carry one; `schedule()` returns those
 * workers for the loader to record as the plugin's problem (#1008), and the
 * plugin's other workers register as usual. #1728 — the scheduler also keeps
 * them (`unscheduled()`) for as long as they are off: the runtime record
 * carries them into plugin health, which would otherwise show them only for
 * the 7 days its error log covers. The next `schedule()` of the plugin (a
 * reload, a release with a fixed pattern) replaces them.
 *
 * Nothing here runs on a timer (#1140). The admin's scheduler tick asks
 * which workers exist, keeps each one's next occurrence in its due-table
 * (`plugin:<slug>/<worker>`), and calls `run()` when it is due — on the
 * platform level, never per plugin, with a per-tick time budget. A worker
 * therefore runs at its cron's cadence rounded up to the tick (every
 * minute → every tick); work bigger than one run is the plugin's to chunk
 * (the `_run_pending_units` pattern). The due-table's lease, not this
 * process, decides which admin instance runs a worker, so N instances run
 * it once.
 *
 * Failure isolation: a run that throws is recorded on the worker's due-table
 * row and the worker stays scheduled; its next occurrence runs as usual.
 */

import { parseWorkerCron } from "@caelo-cms/plugin-sandbox";
import type { PluginWorkerSpec } from "@caelo-cms/plugin-sdk";
import type { Cron } from "croner";
import type { runPluginOperation } from "./dispatch.js";
import {
  clearUnscheduledWorkers,
  setUnscheduledWorkers,
  type UnscheduledWorker,
  unscheduledWorkersOf,
} from "./unscheduled-workers.js";

export type { UnscheduledWorker } from "./unscheduled-workers.js";

interface ScheduleOpts {
  pluginSlug: string;
  workers: ReadonlyArray<PluginWorkerSpec>;
  dispatch: typeof runPluginOperation;
  pluginActorId: string;
}

/** One registered plugin worker. */
export interface ScheduledWorker {
  readonly pluginSlug: string;
  readonly workerName: string;
  readonly cron: string;
  readonly operationName: string;
  /** False while the plugin is disabled; a paused worker is not run. */
  readonly active: boolean;
  /** The first occurrence of the cron strictly after `from`, or null when there is none. */
  nextAfter(from: Date): Date | null;
  /** Run the worker once. Throws when the plugin operation fails. */
  run(): Promise<void>;
}

interface Entry {
  readonly pluginSlug: string;
  readonly workerName: string;
  readonly cron: string;
  readonly operationName: string;
  readonly pattern: Cron;
  readonly run: () => Promise<void>;
}

/** One run of worker `w`: the plugin operation it names, on each public database it works on. */
function workerRun(opts: ScheduleOpts, w: PluginWorkerSpec): () => Promise<void> {
  return async () => {
    // #1333 — `publicDatabases: "each"` runs once per public database,
    // live first; each run sees only its own environment's tables.
    const targets: ReadonlyArray<"live" | "staging"> =
      w.publicDatabases === "each" ? ["live", "staging"] : ["live"];
    const failures: string[] = [];
    for (const target of targets) {
      const r = await opts.dispatch({
        pluginSlug: opts.pluginSlug,
        operationName: w.operationName,
        args: { _trigger: "worker", workerName: w.name },
        pluginActorId: opts.pluginActorId,
        // Workers act on main by design (CMS_REQUIREMENTS §14.7).
        invocation: { origin: "worker", actorId: opts.pluginActorId },
        ...(target === "staging" ? { publicTarget: "staging" as const } : {}),
      });
      // A failed live run must not keep the staging run from its turn,
      // and neither failure may pass unnoticed: the due-table row says so.
      if (!r.ok) failures.push(`${target}: ${r.error.message}`);
    }
    if (failures.length > 0) {
      throw new Error(`worker ${opts.pluginSlug}/${w.name} failed (${failures.join("; ")})`);
    }
  };
}

class WorkerScheduler {
  readonly #byPlugin = new Map<string, Entry[]>();
  readonly #paused = new Set<string>();

  /**
   * Register a plugin's workers, replacing any it had.
   *
   * @returns the workers left off the schedule because croner refused their
   *   cron; empty when every worker registered.
   */
  schedule(opts: ScheduleOpts): ReadonlyArray<UnscheduledWorker> {
    // A plugin loaded again (a reload, an update, two load paths racing)
    // replaces its workers (#1008).
    this.unschedulePlugin(opts.pluginSlug);
    const list: Entry[] = [];
    const unscheduled: UnscheduledWorker[] = [];
    for (const w of opts.workers) {
      const parsed = parseWorkerCron(w.cron);
      if (!parsed.ok) {
        unscheduled.push({ workerName: w.name, cron: w.cron, reason: parsed.problem });
        continue;
      }
      list.push({
        pluginSlug: opts.pluginSlug,
        workerName: w.name,
        cron: w.cron,
        operationName: w.operationName,
        pattern: parsed.pattern,
        run: workerRun(opts, w),
      });
    }
    if (list.length > 0) this.#byPlugin.set(opts.pluginSlug, list);
    // #1728 — kept (unscheduled-workers.ts) for the runtime record.
    setUnscheduledWorkers(opts.pluginSlug, unscheduled);
    return unscheduled;
  }

  /**
   * #1728 — the workers of `pluginSlug` that are off the schedule because
   * croner refused their cron; empty when every worker is registered.
   */
  unscheduled(pluginSlug: string): ReadonlyArray<UnscheduledWorker> {
    return unscheduledWorkersOf(pluginSlug);
  }

  unschedulePlugin(pluginSlug: string): void {
    this.#byPlugin.delete(pluginSlug);
    this.#paused.delete(pluginSlug);
    setUnscheduledWorkers(pluginSlug, []);
  }

  /**
   * Audit fix #2 — pause/resume without unscheduling. Disable pauses the
   * workers in place; re-enable resumes them. They stay registered so
   * re-scheduling on enable is free.
   */
  pausePlugin(pluginSlug: string): void {
    if (this.#byPlugin.has(pluginSlug)) this.#paused.add(pluginSlug);
  }

  resumePlugin(pluginSlug: string): void {
    this.#paused.delete(pluginSlug);
  }

  /** Every registered worker, paused ones included (`active: false`). */
  list(): ReadonlyArray<ScheduledWorker> {
    return [...this.#byPlugin.values()].flat().map((e) => ({
      pluginSlug: e.pluginSlug,
      workerName: e.workerName,
      cron: e.cron,
      operationName: e.operationName,
      active: !this.#paused.has(e.pluginSlug),
      nextAfter: (from: Date) => e.pattern.nextRun(from),
      run: e.run,
    }));
  }

  /** Forget every worker. Used at host shutdown / between test fixtures. */
  shutdown(): void {
    this.#byPlugin.clear();
    this.#paused.clear();
    clearUnscheduledWorkers();
  }
}

export const pluginWorkerScheduler = new WorkerScheduler();

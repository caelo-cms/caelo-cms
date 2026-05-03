// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-host/scheduler — cron-style worker dispatch for Tier-1 plugins.
 *
 * Plugins declare cron-style background jobs in `manifest.workers[]`:
 *
 *   workers: [
 *     { name: "job_runner", cron: "every-30-seconds", operationName: "_run_pending_units" }
 *   ]
 *
 * At plugin activation the host calls `schedulePluginWorkers(...)`, which
 * starts a `Cron` (from `croner`) per worker. Each tick invokes the plugin's
 * named operation via the dispatcher with system actor scope + the plugin's
 * actor row + caelo.plugin_id session vars set.
 *
 * Single-process scheduler. Multi-instance leader election is deferred to
 * P14 (provisioning). Self-hosted Caelo runs one admin instance, so this
 * is sufficient for v1.
 *
 * Failure isolation: a worker tick that throws is logged and the cron job
 * keeps ticking on schedule. Persistent failure surfaces in the plugin's
 * error log surface (Owner UI in P12 review pass).
 */

import type { PluginWorkerSpec } from "@caelo/plugin-sdk";
import { Cron } from "croner";
import type { runPluginOperation } from "./dispatch.js";

export interface ScheduledWorker {
  readonly pluginSlug: string;
  readonly workerName: string;
  readonly cron: string;
  readonly operationName: string;
  readonly job: Cron;
}

class WorkerScheduler {
  readonly #byPlugin = new Map<string, ScheduledWorker[]>();

  schedule(opts: {
    pluginSlug: string;
    workers: ReadonlyArray<PluginWorkerSpec>;
    dispatch: typeof runPluginOperation;
    pluginActorId: string;
  }): void {
    if (opts.workers.length === 0) return;
    const list: ScheduledWorker[] = [];
    for (const w of opts.workers) {
      const job = new Cron(w.cron, { paused: false }, async () => {
        try {
          await opts.dispatch({
            pluginSlug: opts.pluginSlug,
            operationName: w.operationName,
            args: { _trigger: "worker", workerName: w.name },
            pluginActorId: opts.pluginActorId,
          });
        } catch (e) {
          console.warn(
            `[plugin-host] worker ${opts.pluginSlug}/${w.name} (${w.cron}) failed:`,
            (e as Error).message,
          );
        }
      });
      list.push({
        pluginSlug: opts.pluginSlug,
        workerName: w.name,
        cron: w.cron,
        operationName: w.operationName,
        job,
      });
    }
    this.#byPlugin.set(opts.pluginSlug, list);
  }

  unschedulePlugin(pluginSlug: string): void {
    const workers = this.#byPlugin.get(pluginSlug);
    if (!workers) return;
    for (const w of workers) w.job.stop();
    this.#byPlugin.delete(pluginSlug);
  }

  /**
   * Audit fix #2 — pause/resume without unscheduling. Disable pauses the
   * cron jobs in place; re-enable resumes them. The jobs stay in the
   * registry so re-scheduling on enable is free.
   */
  pausePlugin(pluginSlug: string): void {
    const workers = this.#byPlugin.get(pluginSlug);
    if (!workers) return;
    for (const w of workers) w.job.pause();
  }

  resumePlugin(pluginSlug: string): void {
    const workers = this.#byPlugin.get(pluginSlug);
    if (!workers) return;
    for (const w of workers) w.job.resume();
  }

  list(): ReadonlyArray<ScheduledWorker> {
    return [...this.#byPlugin.values()].flat();
  }

  /** Stop every worker. Used at host shutdown / between test fixtures. */
  shutdown(): void {
    for (const workers of this.#byPlugin.values()) {
      for (const w of workers) w.job.stop();
    }
    this.#byPlugin.clear();
  }
}

export const pluginWorkerScheduler = new WorkerScheduler();

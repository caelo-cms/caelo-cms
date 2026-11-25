// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — the triggers that queue plugin batches by
 * themselves: a plugin's load (its `activation` batches, once per
 * version), a successful Stage (`stage`), and the scheduler tick
 * (`schedule`, on each batch's cron). People and the AI start `operator`
 * batches with plugin_batches.start.
 *
 * A queued run's job starts after the run's row committed; a start lost on
 * the way is picked up by the tick's backstop (plugin_batches.unstarted).
 */

import {
  hasGrantedCapability,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  onPluginRegistered,
} from "@caelo-cms/plugin-host";
import type { BatchTrigger, PluginBatchOperation } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { Cron } from "croner";
import { describeError } from "../ai/tools/_describe-error.js";
import { SCHEDULED_TASK_KEY } from "../ops/scheduled_tasks.js";
import { type AdminJobDeps, REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";
import type { ScheduledTask } from "../scheduler/task.js";

function batchesOf(plugin: LoadedPlugin, trigger: BatchTrigger): PluginBatchOperation[] {
  if (isPluginDisabled(plugin.slug) || !hasGrantedCapability(plugin, "batch_jobs")) return [];
  return ((plugin.definition.batchOperations ?? []) as PluginBatchOperation[]).filter((b) =>
    b.triggers.includes(trigger),
  );
}

/** Queues one triggered run; null when the batch is already queued or running (or ran for this version). */
export async function enqueueBatch(
  deps: AdminJobDeps,
  plugin: LoadedPlugin,
  operation: string,
  trigger: "activation" | "stage" | "schedule",
  stageRunId?: string,
): Promise<string | null> {
  const r = await execute(
    deps.registry,
    deps.adapter,
    REPORTING_JOB_CTX,
    "plugin_batches.enqueue",
    {
      pluginId: plugin.pluginId,
      operation,
      trigger,
      ...(stageRunId ? { stageRunId } : {}),
    },
  );
  if (!r.ok) throw new Error(`plugin_batches.enqueue failed: ${describeError(r.error)}`);
  return (r.value as { runId: string | null }).runId;
}

/** After a successful Stage: every active plugin's `stage` batches. Never fails the Stage. */
export async function enqueueStageBatches(deps: AdminJobDeps, stageRunId: string): Promise<void> {
  for (const plugin of loadedPlugins.all()) {
    for (const b of batchesOf(plugin, "stage")) {
      try {
        await enqueueBatch(deps, plugin, b.operation, "stage", stageRunId);
      } catch (e) {
        console.error(
          `[plugin-batches] Stage ${stageRunId}: batch ${plugin.slug}/${b.operation} not queued:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Queue a plugin's `activation` batches whenever it registers in this
 * process (activation, update, reload, boot). The enqueue op runs each once
 * per plugin version, so the boot loads of every instance add nothing.
 * Idempotent; returns the removal (tests).
 */
export function bootstrapPluginBatchTriggers(deps: AdminJobDeps): () => void {
  if (unsubscribe) return unsubscribe;
  const off = onPluginRegistered(async (plugin) => {
    for (const b of batchesOf(plugin, "activation"))
      await enqueueBatch(deps, plugin, b.operation, "activation");
  });
  unsubscribe = () => {
    off();
    unsubscribe = null;
  };
  return unsubscribe;
}

/** The scheduler task key of a scheduled batch. */
export function pluginBatchTaskKey(slug: string, operation: string): string {
  return `plugin-batch:${slug}/${operation}`;
}

/** One tick task per scheduled batch of an active plugin: due on its cron, it queues a run. */
export function pluginBatchTasks(deps: AdminJobDeps): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const plugin of loadedPlugins.all()) {
    for (const b of batchesOf(plugin, "schedule")) {
      const key = pluginBatchTaskKey(plugin.slug, b.operation);
      if (!SCHEDULED_TASK_KEY.test(key) || !b.schedule) continue;
      let pattern: Cron;
      try {
        pattern = new Cron(b.schedule, { paused: true });
      } catch (e) {
        console.error(
          `[plugin-batches] ${plugin.slug}/${b.operation} has no valid schedule ("${b.schedule}"): ${e instanceof Error ? e.message : e}`,
        );
        continue;
      }
      tasks.push({
        key,
        cadence: { nextAfter: (from) => pattern.nextRun(from) },
        leaseSeconds: 60,
        run: async () => {
          await enqueueBatch(deps, plugin, b.operation, "schedule");
          return undefined;
        },
      });
    }
  }
  return tasks;
}

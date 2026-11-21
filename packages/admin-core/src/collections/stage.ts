// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R1 #1647, R2 #1648) — what a Stage does for page output and
 * collections once its build is recorded: commit the observers' deliveries,
 * plan the run's collection releases and start the index job; and what it
 * undoes when the build fails.
 *
 * Both steps run after `deploy.finish_trigger`, as the system, in their own
 * transactions. An admin that dies between them leaves deliveries pending
 * (the next Stage sends those pages again) or a run without collection
 * releases (Publish live refuses it and asks for a new Stage): never a run
 * that serves an index it did not build.
 */

import { execute } from "@caelo-cms/query-api";
import { EMBEDDING_MODEL_IDS, type ExecutionContext, embeddingModel } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import { startReportingJob } from "../reporting-jobs/launcher.js";
import { activeCollections } from "./ops.js";

/** Observers whose page output failed in this Stage, as the build reported them. */
export interface FailedObserver {
  readonly pluginId: string;
  readonly error: string;
}

/** The value at a dotted config path (`semantic.model`), or undefined. */
function valueAt(values: Record<string, unknown>, path: string): unknown {
  let at: unknown = values;
  for (const part of path.split(".")) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/**
 * #1650 — the embedding model each collection's configuration names for
 * this Stage (its `vectorModelConfig` leaf), read once per plugin on main,
 * which the Stage just built. A model the catalog no longer has fails that
 * plugin's index loudly instead of indexing without vectors.
 */
async function configuredVectorModels(
  deps: AdminJobDeps,
  sys: ExecutionContext,
): Promise<{
  models: { pluginId: string; collection: string; model: string | null }[];
  failed: FailedObserver[];
}> {
  const models: { pluginId: string; collection: string; model: string | null }[] = [];
  const failed: FailedObserver[] = [];
  const bySlug = new Map<string, Record<string, unknown> | Error>();
  for (const c of activeCollections()) {
    const path = c.decl.vectorModelConfig;
    if (path === undefined) continue;
    let values = bySlug.get(c.slug);
    if (values === undefined) {
      const r = await execute(deps.registry, deps.adapter, sys, "plugin_config.get", {
        pluginSlug: c.slug,
      });
      values = r.ok
        ? (r.value as { values: Record<string, unknown> }).values
        : new Error(describeError(r.error));
      bySlug.set(c.slug, values);
    }
    if (values instanceof Error) {
      failed.push({
        pluginId: c.pluginId,
        error: `its configuration could not be read for the embedding model (${values.message})`,
      });
      continue;
    }
    const model = valueAt(values, path);
    if (model === null || model === undefined) {
      models.push({ pluginId: c.pluginId, collection: c.collection, model: null });
    } else if (typeof model === "string" && embeddingModel(model)) {
      models.push({ pluginId: c.pluginId, collection: c.collection, model });
    } else {
      failed.push({
        pluginId: c.pluginId,
        error: `its configuration (${path}) names the embedding model ${JSON.stringify(model)}, which this release's catalog does not have (${EMBEDDING_MODEL_IDS.join(", ")}): pick one in Settings → Plugin settings, or turn semantic search off, and Stage again`,
      });
    }
  }
  return { models, failed };
}

/**
 * After a successful Stage: plan the index, commit the page output, start
 * the index job. Returns a note for the run, or null.
 *
 * The plan comes first: it claims the run's writes (and discards a failed
 * plugin's), and only then does the page output count as delivered. A plan
 * that fails leaves nothing recorded, so the next Stage delivers those
 * pages again; a commit that fails after it costs only a redelivery.
 */
export async function afterStageBuild(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  runId: string,
  failed: readonly FailedObserver[],
): Promise<string | null> {
  const vectors = await configuredVectorModels(deps, sys);
  const failures = [
    ...failed,
    ...vectors.failed.filter((v) => !failed.some((f) => f.pluginId === v.pluginId)),
  ];
  const planned = await execute(deps.registry, deps.adapter, sys, "collections.plan_run", {
    runId,
    failed: failures.map((f) => ({ pluginId: f.pluginId, error: f.error.slice(0, 2000) })),
    vectorModels: vectors.models,
  });
  if (!planned.ok) {
    // Nothing of the run counts: its writes never reach an index and its
    // pages come again with the next Stage.
    await afterFailedStage(deps, sys, runId);
    return `the search index of this Stage could not be planned (${describeError(planned.error)}); Stage again`;
  }
  // A failed plugin's writes were discarded by the plan, so it records
  // nothing of this run: the next Stage delivers its pages and removals
  // again instead of the bookkeeping running ahead of the index.
  const committed = await execute(deps.registry, deps.adapter, sys, "page_output.commit_run", {
    runId,
    failedPluginIds: failures.map((f) => f.pluginId),
  });
  if (!committed.ok)
    console.error(
      `[collections] run ${runId}: the page output could not be recorded (${describeError(committed.error)}); the next Stage sends those pages again`,
    );
  const { pending } = planned.value as { pending: number };
  if (pending === 0) return null;
  // Never fails the Stage: the releases are planned, and a start that went
  // wrong is retried by the scheduler tick's backstop (collections.unstarted_runs).
  try {
    const r = await startReportingJob(deps, "collection_index", runId);
    if (r.outcome === "launch-failed" || r.outcome === "given-up")
      console.error(`[collections] run ${runId}: ${r.outcome}: ${r.message}`);
  } catch (e) {
    console.error(
      `[collections] run ${runId}: the index job did not start (the next scheduler tick starts it):`,
      e instanceof Error ? e.message : e,
    );
  }
  return null;
}

/** After a failed Stage: its page output never happened, nor what observers wrote from it. */
export async function afterFailedStage(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  runId: string,
): Promise<void> {
  for (const op of ["page_output.discard_run", "collections.discard_run_changes"] as const) {
    const r = await execute(deps.registry, deps.adapter, sys, op, { runId });
    if (!r.ok)
      console.error(`[deploy] could not discard the failed Stage's page output (${op})`, {
        runId,
        error: describeError(r.error),
      });
  }
}

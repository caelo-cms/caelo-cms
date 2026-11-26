// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R2, issue #1648) — collections at Publish live.
 *
 * The gate: a Stage goes live only with a ready release of every active
 * collection; a pending one waits for its index job, a failed one names the
 * cause, a missing one (the plugin was activated after the Stage) asks for
 * a new Stage.
 *
 * The copy: before the live pointer moves, every file of the run's ready
 * releases that the live store lacks is copied from the staging store. Files
 * are content-addressed, so a delta release copies only its delta, and the
 * live gateway never meets a release whose files are not there yet. A
 * rollback points back at a release whose files the live store still holds
 * (collection GC keeps the files of every release a retained run names).
 */

import { copyMissing, FileCache, parseRelease, releaseFiles } from "@caelo-cms/collection-index";
import {
  collectionPrefix,
  collectionStoreFromEnv,
  LIVE_COLLECTION_STORE_ENV,
  loadedPlugins,
  STAGING_COLLECTION_STORE_ENV,
} from "@caelo-cms/plugin-host";
import { execute, type TransactionRunner } from "@caelo-cms/query-api";
import { describeSearchIndexProgress, type ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { describeError } from "../ai/tools/_describe-error.js";
import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import { activeCollections } from "./ops.js";
import { summarizeIndexProgress } from "./progress.js";

/** Why the run cannot go live with its collections, or null when it can. */
export async function collectionGateProblem(
  tx: TransactionRunner,
  runId: string,
): Promise<string | null> {
  const active = activeCollections();
  if (active.length === 0) return null;
  const rows = (await tx.execute(sql`
    SELECT plugin_id::text AS plugin_id, collection, state, error, progress, now() AS now
      FROM collection_releases WHERE run_id = ${runId}::uuid
  `)) as unknown as {
    plugin_id: string;
    collection: string;
    state: string;
    error: string | null;
    progress: unknown;
    now: string | Date;
  }[];
  const byKey = new Map(rows.map((r) => [`${r.plugin_id}:${r.collection}`, r] as const));
  const problems: string[] = [];
  for (const c of active) {
    const r = byKey.get(`${c.pluginId}:${c.collection}`);
    const name = `${c.slug}'s ${c.collection.replace(/_/g, " ")} index`;
    if (!r)
      problems.push(
        `${name} is not part of this Stage (the plugin started after it): Stage again, then Publish live`,
      );
    else if (r.state === "pending") {
      const now = r.now instanceof Date ? r.now.getTime() : Date.parse(String(r.now));
      const progress = summarizeIndexProgress(r.progress, now);
      const said = describeSearchIndexProgress(progress ?? undefined);
      const detail = said ? ` (${said})` : "";
      problems.push(
        `${name} is still being built for this Stage${detail}: Publish live opens when it is ready (get_stage_status shows how far it is)`,
      );
    } else if (r.state === "failed")
      problems.push(
        `${name} failed in this Stage: ${r.error ?? "no reason recorded"}. Fix the cause and Stage again`,
      );
  }
  return problems.length > 0
    ? `The search index of this Stage is not ready: ${problems.join("; ")}.`
    : null;
}

/** Copies the files of the run's ready releases to the live store; returns how many it copied. */
export async function copyRunCollectionsToLive(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  runId: string,
): Promise<number> {
  const state = await execute(deps.registry, deps.adapter, sys, "collections.run_state", { runId });
  if (!state.ok) throw new Error(`collections.run_state failed: ${describeError(state.error)}`);
  const rows = (
    state.value as {
      collections: {
        pluginId: string;
        collection: string;
        state: string;
        releaseKey: string | null;
      }[];
    }
  ).collections
    .filter((c) => c.state === "ready" && c.releaseKey !== null)
    .map((c) => ({
      plugin_id: c.pluginId,
      collection: c.collection,
      release_key: c.releaseKey as string,
    }));
  if (rows.length === 0) return 0;
  const staging = collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV);
  const live = collectionStoreFromEnv(LIVE_COLLECTION_STORE_ENV);
  let copied = 0;
  for (const r of rows) {
    const slug = loadedPlugins.byId(r.plugin_id)?.slug;
    if (!slug) continue;
    const prefix = collectionPrefix(slug, r.collection);
    const cache = new FileCache({ read: (f) => staging.read(`${prefix}/${f}`) }, 64 * 1024 * 1024);
    const manifest = parseRelease(await staging.read(`${prefix}/${r.release_key}`));
    const files = await releaseFiles(manifest, cache);
    // The release file last: a reader that finds it finds every file it names.
    copied += await copyMissing(
      staging,
      live,
      [...files].map((f) => `${prefix}/${f}`),
    );
    copied += await copyMissing(staging, live, [`${prefix}/${r.release_key}`]);
  }
  return copied;
}

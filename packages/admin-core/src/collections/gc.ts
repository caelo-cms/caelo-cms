// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R2, issue #1648) — clean-up of the collection stores.
 *
 * Index files are immutable and shared between releases (a delta keeps the
 * segments of the release before it), so a file may be deleted only when no
 * release that can still be served names it. Kept are the releases of:
 *
 *   - the last {@link KEEP_STAGES} Stages of each collection (the next
 *     Publish live promotes one of them, and the delta base is among them);
 *   - every Stage the last {@link KEEP_PUBLISHES} Publish live (and
 *     rollback) runs released — a rollback to one of them gets its index;
 *   - both pointers, and any release still being built and its base.
 *
 * Everything else under a collection's prefix goes, in both stores, and the
 * releases that lost their files are marked `collected_at`: a rollback to
 * such a build is refused with the reason instead of serving a missing
 * index. A collection with an index job running keeps its staging files
 * this round (the job writes files before the release that names them).
 * Change files go once their changes are in a ready release.
 *
 * Runs on the scheduler tick (`core:collections-gc`), in the admin, which
 * holds the right to delete in both stores.
 */

import {
  type CollectionStore,
  FileCache,
  parseRelease,
  releaseFiles,
} from "@caelo-cms/collection-index";
import {
  collectionPrefix,
  collectionStoreFromEnv,
  LIVE_COLLECTION_STORE_ENV,
  STAGING_COLLECTION_STORE_ENV,
} from "@caelo-cms/plugin-host";
import { defineOperation, execute } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { type AdminJobDeps, REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";

/** Stages per collection whose releases stay. */
export const KEEP_STAGES = 10;

/** Publish live runs whose released Stages keep their indexes (the rollback range). */
export const KEEP_PUBLISHES = 20;

/** Store files one clean-up run deletes at most; the next run goes on. */
export const MAX_DELETES_PER_RUN = 20_000;

/**
 * Files younger than this are never deleted, whatever the plan says. The
 * keep set is read before the deletes, and a writer still in flight is in
 * none of it yet: a Stage's index job writing new segments, a Publish live
 * copying a release whose manifest lands last. Names are content-addressed
 * and never rewritten, so a file's age is when it was written; every such
 * writer finishes well inside the window, and the next round decides.
 */
export const GC_GRACE_MS = 6 * 60 * 60 * 1000;

const planSchema = z.object({
  collections: z.array(
    z.object({
      pluginId: z.string(),
      slug: z.string(),
      collection: z.string(),
      /** An index job is building one of its releases: its staging files stay this round. */
      building: z.boolean(),
      keep: z.array(z.object({ runId: z.string(), releaseKey: z.string() })),
      collect: z.array(z.string()),
    }),
  ),
  changes: z.array(z.object({ id: z.string(), key: z.string() })),
});
type Plan = z.infer<typeof planSchema>;

export const collectionsGcPlanOp = defineOperation({
  name: "collections.gc_plan",
  // Why site-wide: the clean-up compares every collection's releases with
  // the rollback range of every Publish live, once a day.
  readScope: "site",
  // Why system-only: the scheduler tick's clean-up.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      changeLimit: z.number().int().min(1).max(50_000),
      keepStages: z.number().int().min(1).max(1000),
      keepPublishes: z.number().int().min(1).max(1000),
    })
    .strict(),
  output: planSchema,
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      WITH published AS (
        SELECT r.projection_run_id AS run_id FROM deploy_runs r
          JOIN deploy_targets t ON t.id = r.target_id
         WHERE t.env = 'production' AND r.status = 'succeeded' AND r.projection_run_id IS NOT NULL
         ORDER BY r.finished_at DESC NULLS LAST
         LIMIT ${input.keepPublishes}
      ),
      pointed AS (SELECT run_id FROM projection_release_pointers),
      ranked AS (
        SELECT c.*, row_number() OVER (
                 PARTITION BY c.plugin_id, c.collection ORDER BY c.created_at DESC) AS n
          FROM collection_releases c
      ),
      bases AS (
        SELECT previous_run_id AS run_id, plugin_id, collection FROM collection_releases
         WHERE state = 'pending' AND previous_run_id IS NOT NULL
      )
      SELECT k.run_id::text AS run_id, k.plugin_id::text AS plugin_id, p.slug, k.collection,
             k.state, k.release_key, k.collected_at IS NOT NULL AS collected,
             (k.n <= ${input.keepStages}
              OR k.state = 'pending'
              OR k.run_id IN (SELECT run_id FROM published)
              OR k.run_id IN (SELECT run_id FROM pointed)
              OR EXISTS (SELECT 1 FROM bases b WHERE b.run_id = k.run_id
                           AND b.plugin_id = k.plugin_id AND b.collection = k.collection)) AS kept
        FROM ranked k JOIN plugins p ON p.id = k.plugin_id
    `)) as unknown as {
      run_id: string;
      plugin_id: string;
      slug: string;
      collection: string;
      state: "pending" | "ready" | "failed";
      release_key: string | null;
      collected: boolean;
      kept: boolean;
    }[];
    const byCollection = new Map<string, Plan["collections"][number]>();
    for (const r of rows) {
      const id = `${r.plugin_id}:${r.collection}`;
      let c = byCollection.get(id);
      if (!c) {
        c = {
          pluginId: r.plugin_id,
          slug: r.slug,
          collection: r.collection,
          building: false,
          keep: [],
          collect: [],
        };
        byCollection.set(id, c);
      }
      if (r.state === "pending") c.building = true;
      if (r.kept && r.release_key) c.keep.push({ runId: r.run_id, releaseKey: r.release_key });
      else if (!r.kept && r.state === "ready" && !r.collected) c.collect.push(r.run_id);
    }
    // Changes in a ready release are never read again (a retry rebuilds
    // from the release before it, which already holds them).
    const changes = (await tx.execute(sql`
      SELECT c.id::text AS id, c.store_key AS key FROM collection_changes c
        JOIN collection_releases r ON r.run_id = c.applied_run_id
             AND r.plugin_id = c.plugin_id AND r.collection = c.collection AND r.state = 'ready'
       WHERE c.applied_run_id IS NOT NULL
       LIMIT ${input.changeLimit}
    `)) as unknown as { id: string; key: string }[];
    return ok({ collections: [...byCollection.values()], changes });
  },
});

export const collectionsGcMarkOp = defineOperation({
  name: "collections.gc_mark",
  readScope: "request",
  // Why system-only: the clean-up records what it deleted.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      collected: z
        .array(
          z
            .object({
              runId: z.string().uuid(),
              pluginId: z.string().uuid(),
              collection: z.string(),
            })
            .strict(),
        )
        .max(10_000),
      changeIds: z.array(z.string().uuid()).max(50_000),
    })
    .strict(),
  output: z.object({ releases: z.number().int(), changes: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    let releases = 0;
    for (const c of input.collected) {
      const r = (await tx.execute(sql`
        UPDATE collection_releases SET collected_at = now()
         WHERE run_id = ${c.runId}::uuid AND plugin_id = ${c.pluginId}::uuid
           AND collection = ${c.collection} AND collected_at IS NULL
        RETURNING run_id
      `)) as unknown as unknown[];
      releases += r.length;
    }
    let changes = 0;
    if (input.changeIds.length > 0) {
      const r = (await tx.execute(sql`
        DELETE FROM collection_changes WHERE id = ANY(${`{${input.changeIds.join(",")}}`}::uuid[])
        RETURNING id
      `)) as unknown as unknown[];
      changes = r.length;
    }
    return ok({ releases, changes });
  },
});

/** The files (with the release file) every kept release of a collection names in `store`. */
async function keptFiles(
  store: CollectionStore,
  prefix: string,
  keep: readonly { releaseKey: string }[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const cache = new FileCache({ read: (f) => store.read(`${prefix}/${f}`) }, 64 * 1024 * 1024);
  for (const k of keep) {
    const bytes = await store.readIfExists(`${prefix}/${k.releaseKey}`);
    if (!bytes) continue;
    out.add(`${prefix}/${k.releaseKey}`);
    for (const f of await releaseFiles(parseRelease(bytes), cache)) out.add(`${prefix}/${f}`);
  }
  return out;
}

/** What one clean-up run did. */
export interface CollectionsGcReport {
  readonly deletedFiles: number;
  readonly collectedReleases: number;
  readonly deletedChanges: number;
}

/** One clean-up run over both stores. */
export async function runCollectionsGc(
  deps: AdminJobDeps,
  opts: {
    readonly keepStages?: number;
    readonly keepPublishes?: number;
    /** Tests only: how old a file must be to go ({@link GC_GRACE_MS}). */
    readonly graceMs?: number;
  } = {},
): Promise<CollectionsGcReport> {
  const planned = await execute(
    deps.registry,
    deps.adapter,
    REPORTING_JOB_CTX,
    "collections.gc_plan",
    {
      changeLimit: 5_000,
      keepStages: opts.keepStages ?? KEEP_STAGES,
      keepPublishes: opts.keepPublishes ?? KEEP_PUBLISHES,
    },
  );
  if (!planned.ok) throw new Error(`collections.gc_plan failed: ${describeError(planned.error)}`);
  const plan = planned.value as Plan;
  if (plan.collections.length === 0 && plan.changes.length === 0)
    return { deletedFiles: 0, collectedReleases: 0, deletedChanges: 0 };
  const staging = collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV);
  const live = collectionStoreFromEnv(LIVE_COLLECTION_STORE_ENV);
  let deleted = 0;
  const collected: { runId: string; pluginId: string; collection: string }[] = [];
  for (const c of plan.collections) {
    if (deleted >= MAX_DELETES_PER_RUN) break;
    const prefix = collectionPrefix(c.slug, c.collection);
    // Change files have their own rule (below): only a recorded, applied one goes.
    const changes = `${prefix}/changes/`;
    let complete = true;
    for (const [store, skip] of [
      [staging, c.building],
      [live, false],
    ] as const) {
      if (skip) {
        complete = false;
        continue;
      }
      const keep = await keptFiles(store, prefix, c.keep);
      const youngerThan = Date.now() - (opts.graceMs ?? GC_GRACE_MS);
      // A directory-like listing: every key under `<slug>/<collection>/`.
      for (const { key, writtenAt } of await store.listEntries(prefix)) {
        if (key.startsWith(changes) || keep.has(key)) continue;
        // A writer in flight (above): this round leaves it, the next decides.
        if (writtenAt > youngerThan) continue;
        if (deleted >= MAX_DELETES_PER_RUN) {
          complete = false;
          break;
        }
        await store.delete(key);
        deleted++;
      }
    }
    // Marked only once both stores lost the files: until then a rollback
    // to the build may still find them.
    if (complete)
      for (const runId of c.collect)
        collected.push({ runId, pluginId: c.pluginId, collection: c.collection });
  }
  const changeIds: string[] = [];
  for (const ch of plan.changes) {
    await staging.delete(ch.key);
    changeIds.push(ch.id);
  }
  const marked = await execute(
    deps.registry,
    deps.adapter,
    REPORTING_JOB_CTX,
    "collections.gc_mark",
    {
      collected,
      changeIds,
    },
  );
  if (!marked.ok) throw new Error(`collections.gc_mark failed: ${describeError(marked.error)}`);
  const v = marked.value as { releases: number; changes: number };
  return { deletedFiles: deleted, collectedReleases: v.releases, deletedChanges: v.changes };
}

/**
 * Why a rollback to the build that released Stage `projectionRunId` would
 * serve a missing search index, or null.
 */
export async function collectionRollbackProblem(
  tx: { execute(q: ReturnType<typeof sql>): Promise<unknown> },
  projectionRunId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT p.slug, c.collection FROM collection_releases c JOIN plugins p ON p.id = c.plugin_id
     WHERE c.run_id = ${projectionRunId}::uuid AND c.collected_at IS NOT NULL
  `)) as unknown as { slug: string; collection: string }[];
  if (rows.length === 0) return null;
  return `the search index this build was released with (${rows.map((r) => `${r.slug}/${r.collection}`).join(", ")}) was cleaned up — only the last ${KEEP_PUBLISHES} Publish live runs keep theirs. Roll back to a newer build, or Stage and Publish live instead.`;
}

/**
 * Deletes every collection file of an uninstalled plugin in both stores
 * (its tables and schemas go with the same uninstall). A store this install
 * does not have is skipped; a deletion that fails is left to the operator
 * (the files are unreachable without the plugin and cost only storage).
 */
export async function deletePluginCollectionFiles(slug: string): Promise<number> {
  let deleted = 0;
  for (const envVar of [STAGING_COLLECTION_STORE_ENV, LIVE_COLLECTION_STORE_ENV]) {
    if (!process.env[envVar]) continue;
    const store = collectionStoreFromEnv(envVar);
    for (const key of await store.list(slug)) {
      await store.delete(key);
      deleted++;
    }
  }
  return deleted;
}

/** The clean-up ops, for register.ts. */
export const COLLECTION_GC_OPS = [collectionsGcPlanOp, collectionsGcMarkOp] as const;

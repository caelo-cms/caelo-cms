// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R2, issue #1648) — a Stage's collection index, the admin's
 * bookkeeping.
 *
 *   collections.finish_stage  after the build, one Stage at a time in build
 *                             order: one release row per active collection
 *                             (carried over, pending for the index job, or
 *                             failed) and the page-output commit; a Stage a
 *                             newer one finished before is superseded
 *   collections.index_tasks   the job asks what to index (a release's members)
 *   collections.index_done    the job reports a release file
 *   collections.index_failed  the job reports a failure
 *   collections.run_state     every collection release of a run (Publish live's gate)
 *
 * A change keeps the run that wrote it and counts as applied once a ready
 * release has it as a member; a failed index leaves it unapplied, so the
 * next Stage builds it in again and nothing is lost.
 */

import { schemaDigest } from "@caelo-cms/collection-index";
import { isPluginDisabled, loadedPlugins } from "@caelo-cms/plugin-host";
import type { PluginCollectionManifest } from "@caelo-cms/plugin-sdk";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { commitPageOutputRun, discardPageOutputRun } from "../ops/page_output.js";
import { jsonbParam } from "../sql-helpers.js";

const uuid = z.string().uuid();

/** An active plugin's declared collection. */
export interface ActiveCollection {
  readonly pluginId: string;
  readonly slug: string;
  readonly collection: string;
  readonly decl: PluginCollectionManifest;
}

/** Every collection of every active plugin that holds the `collections` grant. */
export function activeCollections(): ActiveCollection[] {
  const out: ActiveCollection[] = [];
  for (const p of loadedPlugins.all()) {
    if (isPluginDisabled(p.slug)) continue;
    const granted =
      p.provenance === "runtime-authored"
        ? (p.externalApproval?.capabilities.includes("collections") ?? false)
        : (p.definition.requestedCapabilities ?? []).includes("collections");
    if (!granted) continue;
    for (const [collection, decl] of Object.entries(p.definition.collections ?? {})) {
      out.push({ pluginId: p.pluginId, slug: p.slug, collection, decl });
    }
  }
  return out;
}

/** The engine schema digest of a declaration (fields only). */
export function declarationDigest(decl: PluginCollectionManifest): string {
  return schemaDigest({ fields: decl.fields });
}

interface ReleaseRow {
  run_id: string;
  release_key: string;
  stats: Record<string, unknown>;
  vector_model: string | null;
}

/** The advisory-lock class of one collection's release protocol (epic #1644). */
const COLLECTION_LOCK_CLASS = 1644;

/**
 * The advisory-lock class (key 0) that orders every Stage's finish: its
 * collection plan and its page-output commit, one Stage at a time.
 */
const STAGE_FINISH_LOCK_CLASS = 1666;

/**
 * Serialises a collection's release selection with its index completion.
 * A plan reads the newest ready release and claims every change no index
 * applied: both reads must see one state. Without the lock an index that
 * completes between them marks its changes applied after the plan chose the
 * release before it, and the new index misses them for good.
 */
async function lockCollection(
  tx: TransactionRunner,
  pluginId: string,
  collection: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${COLLECTION_LOCK_CLASS}::int, hashtext(${`${pluginId}:${collection}`}))`,
  );
}

async function previousReady(
  tx: TransactionRunner,
  pluginId: string,
  collection: string,
): Promise<ReleaseRow | null> {
  const rows = (await tx.execute(sql`
    SELECT run_id::text AS run_id, release_key, stats, vector_model FROM collection_releases
    WHERE plugin_id = ${pluginId}::uuid AND collection = ${collection} AND state = 'ready'
    ORDER BY created_at DESC LIMIT 1
  `)) as unknown as ReleaseRow[];
  return rows[0] ?? null;
}

export const collectionsFinishStageOp = defineOperation({
  name: "collections.finish_stage",
  readScope: "request",
  // Why system-only: the Stage's trigger finishes its own page output.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      /** Plugins whose page-output observer failed in this Stage. */
      failed: z
        .array(z.object({ pluginId: uuid, error: z.string().max(2000) }).strict())
        .max(64)
        .default([]),
      /**
       * #1650 — per collection with a `vectorModelConfig`, the catalog model
       * its configuration names for this Stage (null: semantic search off).
       * A collection missing here has no vector model.
       */
      vectorModels: z
        .array(
          z
            .object({
              pluginId: uuid,
              collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
              model: z
                .string()
                .regex(/^[a-z0-9][a-z0-9.-]{0,79}$/)
                .nullable(),
            })
            .strict(),
        )
        .max(256)
        .default([]),
    })
    .strict(),
  output: z.object({
    /** A newer Stage finished first: this one records nothing of its own. */
    superseded: z.boolean(),
    pending: z.number().int(),
    carried: z.number().int(),
    failed: z.number().int(),
  }),
  handler: async (_ctx, input, tx) => {
    // Every Stage finishes one at a time, in the order its build started.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STAGE_FINISH_LOCK_CLASS}::int, 0)`);
    const [run] = (await tx.execute(sql`
      SELECT started_at FROM deploy_runs WHERE id = ${input.runId}::uuid AND started_at IS NOT NULL
    `)) as unknown as { started_at: string }[];
    if (!run)
      return err({
        kind: "HandlerError",
        operation: "collections.finish_stage",
        message: `run ${input.runId} has no started build to finish`,
      });
    const [newer] = (await tx.execute(sql`
      SELECT run_id::text AS run_id FROM stage_output_commits
      WHERE started_at > ${run.started_at}::timestamptz
      ORDER BY started_at DESC LIMIT 1
    `)) as unknown as { run_id: string }[];
    if (newer) return ok(await supersede(tx, input.runId, newer.run_id));
    const planned = await planCollections(tx, input);
    await commitPageOutputRun(tx, {
      runId: input.runId,
      failedPluginIds: input.failed.map((f) => f.pluginId),
    });
    await tx.execute(sql`
      INSERT INTO stage_output_commits (run_id, started_at) VALUES (${input.runId}::uuid, ${run.started_at}::timestamptz)
      ON CONFLICT (run_id) DO NOTHING
    `);
    return ok({ superseded: false, ...planned });
  },
});

/**
 * Plans a Stage's collection releases (inside `collections.finish_stage`):
 * each active collection's release is carried over, pending with its
 * members, or failed (the plugin's observer failed, or its embedding model
 * is missing: the run's writes of that plugin are discarded).
 */
async function planCollections(
  tx: TransactionRunner,
  input: z.infer<typeof collectionsFinishStageOp.input>,
): Promise<{ pending: number; carried: number; failed: number }> {
  const failedBy = new Map(input.failed.map((f) => [f.pluginId, f.error] as const));
  const modelOf = new Map(
    input.vectorModels.map((v) => [`${v.pluginId}:${v.collection}`, v.model] as const),
  );
  let pending = 0;
  let carried = 0;
  let failed = 0;
  // One lock order for every plan: no two plans wait on each other.
  const collections = [...activeCollections()].sort((a, b) =>
    `${a.pluginId}:${a.collection}`.localeCompare(`${b.pluginId}:${b.collection}`),
  );
  for (const c of collections) {
    await lockCollection(tx, c.pluginId, c.collection);
    const previous = await previousReady(tx, c.pluginId, c.collection);
    const failure = failedBy.get(c.pluginId);
    if (failure !== undefined) {
      await tx.execute(sql`
        INSERT INTO collection_releases (run_id, plugin_id, collection, state, previous_run_id, error, finished_at)
        VALUES (${input.runId}::uuid, ${c.pluginId}::uuid, ${c.collection}, 'failed', ${previous?.run_id ?? null},
                ${`the plugin's page-output observer failed: ${failure}`}, now())
        ON CONFLICT (run_id, plugin_id, collection) DO NOTHING
      `);
      // What the observer wrote before it failed is not its delivery: its
      // pages are delivered again by the next Stage, so these partial
      // writes are discarded, never claimed by a later index.
      await tx.execute(sql`
        UPDATE collection_changes SET discarded_at = now()
        WHERE plugin_id = ${c.pluginId}::uuid AND collection = ${c.collection}
          AND run_id = ${input.runId}::uuid AND applied_run_id IS NULL AND discarded_at IS NULL
      `);
      failed++;
      continue;
    }
    // The release's members: every change no ready release applied yet
    // that the run wrote, that no Stage wrote, or that a Stage wrote whose
    // plan recorded this collection (its index still building or failed;
    // a failed plugin's writes it discarded). A change stays with the run
    // that wrote it and with every release that has it as a member: an
    // earlier release still being built keeps its own, this one builds
    // them in too, on the newest ready release. A Stage not yet planned
    // keeps its writes (still running, or finished before its plan
    // discarded a failed observer's partial writes): its own plan or its
    // discard decides them. The per-collection lock orders this with that
    // plan and with every index completion.
    const claimed = (await tx.execute(sql`
      INSERT INTO collection_release_changes (run_id, plugin_id, collection, change_id)
      SELECT ${input.runId}::uuid, c.plugin_id, c.collection, c.id FROM collection_changes c
      WHERE c.plugin_id = ${c.pluginId}::uuid AND c.collection = ${c.collection}
        AND c.applied_run_id IS NULL AND c.discarded_at IS NULL
        AND (c.run_id IS NULL OR c.run_id = ${input.runId}::uuid
             OR EXISTS (SELECT 1 FROM collection_releases r WHERE r.run_id = c.run_id
                          AND r.plugin_id = c.plugin_id AND r.collection = c.collection))
      ON CONFLICT DO NOTHING
      RETURNING change_id
    `)) as unknown as { change_id: string }[];
    const digest = declarationDigest(c.decl);
    const model = modelOf.get(`${c.pluginId}:${c.collection}`) ?? null;
    // A model change is a rebuild: the job re-embeds every passage.
    const unchanged =
      previous !== null &&
      claimed.length === 0 &&
      previous.stats.schemaDigest === digest &&
      previous.vector_model === model;
    if (unchanged) {
      await tx.execute(sql`
        INSERT INTO collection_releases (run_id, plugin_id, collection, state, release_key, previous_run_id, stats, vector_model, finished_at)
        VALUES (${input.runId}::uuid, ${c.pluginId}::uuid, ${c.collection}, 'ready', ${previous.release_key},
                ${previous.run_id}::uuid, ${jsonbParam({ ...previous.stats, carried: true })}, ${model}, now())
        ON CONFLICT (run_id, plugin_id, collection) DO NOTHING
      `);
      carried++;
    } else {
      await tx.execute(sql`
        INSERT INTO collection_releases (run_id, plugin_id, collection, state, previous_run_id, vector_model)
        VALUES (${input.runId}::uuid, ${c.pluginId}::uuid, ${c.collection}, 'pending', ${previous?.run_id ?? null}, ${model})
        ON CONFLICT (run_id, plugin_id, collection) DO NOTHING
      `);
      pending++;
    }
  }
  return { pending, carried, failed };
}

/**
 * A newer Stage finished first. It delivered everything that differs from
 * the observations it found, which this Stage never committed, so it covers
 * this Stage's pages: this Stage records nothing (its deliveries and writes
 * are dropped) and its index is superseded. Applying its older writes over
 * the newer index would bring old text back.
 */
async function supersede(
  tx: TransactionRunner,
  runId: string,
  newerRunId: string,
): Promise<{ superseded: true; pending: 0; carried: 0; failed: number }> {
  await discardPageOutputRun(tx, runId);
  await tx.execute(sql`
    UPDATE collection_changes SET discarded_at = now()
    WHERE run_id = ${runId}::uuid AND applied_run_id IS NULL AND discarded_at IS NULL
  `);
  let failed = 0;
  for (const c of activeCollections()) {
    await tx.execute(sql`
      INSERT INTO collection_releases (run_id, plugin_id, collection, state, error, finished_at)
      VALUES (${runId}::uuid, ${c.pluginId}::uuid, ${c.collection}, 'failed',
              ${`superseded: a newer Stage (run ${newerRunId}) finished first and indexes these pages`}, now())
      ON CONFLICT (run_id, plugin_id, collection) DO NOTHING
    `);
    failed++;
  }
  return { superseded: true, pending: 0, carried: 0, failed };
}

/** One collection the index job builds. */
export const indexTaskSchema = z.object({
  pluginId: z.string(),
  slug: z.string(),
  collection: z.string(),
  /** The collection's declared fields (the engine schema). */
  fields: z.record(z.string(), z.record(z.string(), z.unknown())),
  schemaDigest: z.string(),
  maxDocuments: z.number().int(),
  previousReleaseKey: z.string().nullable(),
  previousSchemaDigest: z.string().nullable(),
  /** #1650 — the catalog model to embed passages with; null: no vectors. */
  vectorModel: z.string().nullable(),
  /** Change files of the run, oldest first. */
  changeKeys: z.array(z.string()),
});
export type IndexTask = z.infer<typeof indexTaskSchema>;

export const collectionIndexTasksOp = defineOperation({
  name: "collections.index_tasks",
  readScope: "request",
  // Why system-only: the index job reaches it through its reports.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({ tasks: z.array(indexTaskSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.plugin_id::text AS plugin_id, r.collection, r.vector_model,
             p.release_key AS previous_key, p.stats AS previous_stats
      FROM collection_releases r
      LEFT JOIN collection_releases p ON p.run_id = r.previous_run_id AND p.plugin_id = r.plugin_id AND p.collection = r.collection
      WHERE r.run_id = ${input.runId}::uuid AND r.state = 'pending'
    `)) as unknown as {
      plugin_id: string;
      collection: string;
      vector_model: string | null;
      previous_key: string | null;
      previous_stats: Record<string, unknown> | null;
    }[];
    const active = new Map(
      activeCollections().map((c) => [`${c.pluginId}:${c.collection}`, c] as const),
    );
    const tasks: IndexTask[] = [];
    for (const r of rows) {
      const c = active.get(`${r.plugin_id}:${r.collection}`);
      if (!c) continue;
      // The release's members, in the order they were written.
      const changes = (await tx.execute(sql`
        SELECT c.store_key FROM collection_release_changes m
        JOIN collection_changes c ON c.id = m.change_id
        WHERE m.run_id = ${input.runId}::uuid AND m.plugin_id = ${r.plugin_id}::uuid AND m.collection = ${r.collection}
        ORDER BY c.created_at, c.id
      `)) as unknown as { store_key: string }[];
      tasks.push({
        pluginId: r.plugin_id,
        slug: c.slug,
        collection: r.collection,
        fields: c.decl.fields as Record<string, Record<string, unknown>>,
        schemaDigest: declarationDigest(c.decl),
        maxDocuments: c.decl.maxDocuments,
        previousReleaseKey: r.previous_key,
        previousSchemaDigest:
          typeof r.previous_stats?.schemaDigest === "string" ? r.previous_stats.schemaDigest : null,
        vectorModel: r.vector_model,
        changeKeys: changes.map((x) => x.store_key),
      });
    }
    return ok({ tasks });
  },
});

export const collectionIndexDoneOp = defineOperation({
  name: "collections.index_done",
  readScope: "request",
  // Why system-only: see index_tasks.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      pluginId: uuid,
      collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      releaseKey: z.string().regex(/^[a-z0-9-]+\.json$/),
      stats: z.record(z.string(), z.unknown()),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await lockCollection(tx, input.pluginId, input.collection);
    const updated = (await tx.execute(sql`
      UPDATE collection_releases SET state = 'ready', release_key = ${input.releaseKey}, stats = ${jsonbParam(input.stats)},
             error = NULL, finished_at = now()
      WHERE run_id = ${input.runId}::uuid AND plugin_id = ${input.pluginId}::uuid AND collection = ${input.collection} AND state = 'pending'
      RETURNING run_id
    `)) as unknown as unknown[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "collections.index_done",
        message: "no pending release of this run and collection",
      });
    }
    // Its members are in a ready release now; one an earlier ready release
    // applied keeps that mark.
    await tx.execute(sql`
      UPDATE collection_changes c SET applied_run_id = ${input.runId}::uuid
      FROM collection_release_changes m
      WHERE m.run_id = ${input.runId}::uuid AND m.plugin_id = ${input.pluginId}::uuid
        AND m.collection = ${input.collection} AND c.id = m.change_id AND c.applied_run_id IS NULL
    `);
    return ok({});
  },
});

export const collectionIndexFailedOp = defineOperation({
  name: "collections.index_failed",
  readScope: "request",
  // Why system-only: see index_tasks.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      pluginId: uuid.optional(),
      collection: z.string().max(40).optional(),
      error: z.string().min(1).max(4000),
    })
    .strict(),
  output: z.object({ failed: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    // Without a plugin: the whole run's pending releases (the job gave up).
    const rows = (await tx.execute(
      input.pluginId
        ? sql`UPDATE collection_releases SET state = 'failed', error = ${input.error}, finished_at = now()
              WHERE run_id = ${input.runId}::uuid AND plugin_id = ${input.pluginId}::uuid
                AND collection = ${input.collection ?? ""} AND state = 'pending' RETURNING run_id`
        : sql`UPDATE collection_releases SET state = 'failed', error = ${input.error}, finished_at = now()
              WHERE run_id = ${input.runId}::uuid AND state = 'pending' RETURNING run_id`,
    )) as unknown as unknown[];
    return ok({ failed: rows.length });
  },
});

/** One collection release of a run, as the gate and the Stage status read it. */
export const runCollectionSchema = z.object({
  pluginId: z.string(),
  collection: z.string(),
  state: z.enum(["pending", "ready", "failed"]),
  releaseKey: z.string().nullable(),
  error: z.string().nullable(),
  stats: z.record(z.string(), z.unknown()),
  /** #1650 — the catalog model the Stage embedded with, or null. */
  vectorModel: z.string().nullable(),
});

export const collectionRunStateOp = defineOperation({
  name: "collections.run_state",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({ collections: z.array(runCollectionSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT plugin_id::text AS plugin_id, collection, state, release_key, error, stats, vector_model
          FROM collection_releases WHERE run_id = ${input.runId}::uuid ORDER BY plugin_id, collection`,
    )) as unknown as {
      plugin_id: string;
      collection: string;
      state: "pending" | "ready" | "failed";
      release_key: string | null;
      error: string | null;
      stats: Record<string, unknown>;
      vector_model: string | null;
    }[];
    return ok({
      collections: rows.map((r) => ({
        pluginId: r.plugin_id,
        collection: r.collection,
        state: r.state,
        releaseKey: r.release_key,
        error: r.error,
        stats: r.stats ?? {},
        vectorModel: r.vector_model,
      })),
    });
  },
});

export const collectionUnstartedRunsOp = defineOperation({
  name: "collections.unstarted_runs",
  readScope: "request",
  // Why system-only: the scheduler's backstop starts an index whose start was lost.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.object({ runIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT r.run_id::text AS run_id
      FROM collection_releases r
      WHERE r.state = 'pending' AND r.created_at < now() - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM reporting_jobs j WHERE j.kind = 'collection_index' AND j.subject_id = r.run_id)
      LIMIT ${input.limit}
    `)) as unknown as { run_id: string }[];
    return ok({ runIds: rows.map((r) => r.run_id) });
  },
});

/**
 * A failed Stage: what its observers wrote is discarded, never claimed by a
 * later index. Its page output never happened (page_output.discard_run), so
 * the next Stage delivers those pages again and the observers write what
 * still holds; a page unpublished in between must not live on in the index
 * through an abandoned write.
 */
export const collectionDiscardRunChangesOp = defineOperation({
  name: "collections.discard_run_changes",
  readScope: "request",
  // Why system-only: the Stage's failure path drops what its build delivered.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({ discarded: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE collection_changes SET discarded_at = now()
      WHERE run_id = ${input.runId}::uuid AND applied_run_id IS NULL AND discarded_at IS NULL
      RETURNING id
    `)) as unknown as { id: string }[];
    return ok({ discarded: rows.length });
  },
});

/** Every collection op, for register.ts. */
export const COLLECTION_INDEX_OPS = [
  collectionDiscardRunChangesOp,
  collectionsFinishStageOp,
  collectionIndexTasksOp,
  collectionIndexDoneOp,
  collectionIndexFailedOp,
  collectionRunStateOp,
  collectionUnstartedRunsOp,
] as const;

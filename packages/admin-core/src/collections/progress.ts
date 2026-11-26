// SPDX-License-Identifier: MPL-2.0

/**
 * How far a Stage's search index is (#1644), so the people and the AI
 * waiting for Publish live see why it waits and about how long.
 *
 * Publish live waits until every collection of the Stage is indexed
 * (promote.ts). Most Stages index in about a minute, but a build that
 * embeds many passages (a first index with semantic search, a model
 * change) takes minutes, on a large site tens of them. The index job
 * reports, per task, how many passages it embedded of how many it has
 * (`collections.index_progress`, at most every {@link PROGRESS_EVERY_MS});
 * the Stage status, the Publish live gate and get_stage_status say it with
 * an estimate from the pace so far.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonbParam } from "../sql-helpers.js";

/** How often a task reports its progress while it embeds. */
export const PROGRESS_EVERY_MS = 20_000;

const uuid = z.string().uuid();
const count = z.number().int().min(0).max(50_000_000);

/**
 * The project's Cloud Run CPU quota keeps a build on fewer tasks than it
 * would run (reporting-jobs run-capacity.ts): how many it wants, the quota,
 * and the quota that would give it them. Shown as text, never acted on.
 */
export const indexLimitSchema = z
  .object({
    wantedTasks: z.number().int().min(1).max(64),
    quotaVcpu: z.number().int().min(0).max(1_000_000),
    quotaNeededVcpu: z.number().int().min(1).max(1_000_000),
    // Display only; legacy domain-scoped ids (`example.com:project`) too.
    projectId: z.string().min(1).max(100),
    region: z.string().regex(/^[a-z]+-[a-z]+\d+$/),
  })
  .strict();
export type IndexLimit = z.infer<typeof indexLimitSchema>;

/** The stored progress of a pending release (`collection_releases.progress`). */
export const indexProgressSchema = z.object({
  startedAt: z.string(),
  at: z.string(),
  /** What the attempt embeds in all, and on how many tasks: tasks yet to report count too. */
  planned: count.optional(),
  taskCount: z.number().int().min(1).max(64).optional(),
  tasks: z.record(z.string(), z.object({ embedded: count, toEmbed: count })),
  /** The last report's quota limit; absent while the quota does not narrow the build. */
  limit: indexLimitSchema.optional(),
});

/** A pending index's progress for people: passages so far, tasks, time left. */
export interface IndexProgressSummary {
  readonly embedded: number;
  readonly toEmbed: number;
  readonly tasks: number;
  /** From the pace so far; null before it can be measured. */
  readonly remainingMs: number | null;
  /** When the CPU quota keeps it on fewer tasks than it would run. */
  readonly limit?: IndexLimit;
}

/**
 * The summary of `progress` at `nowMs`, or null for none (an index that
 * embeds nothing, or a job of an earlier release).
 */
export function summarizeIndexProgress(raw: unknown, nowMs: number): IndexProgressSummary | null {
  const parsed = indexProgressSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const parts = Object.values(p.tasks);
  if (parts.length === 0) return null;
  const embedded = parts.reduce((n, t) => n + t.embedded, 0);
  // The plan's total: a task that has not reported yet (queued, or a
  // retry's tasks still starting) leaves its share in what is left.
  const toEmbed = Math.max(
    p.planned ?? 0,
    parts.reduce((n, t) => n + t.toEmbed, 0),
  );
  const elapsed = Date.parse(p.at) - Date.parse(p.startedAt);
  // The pace of the reports; the time since the last one is part of what is left.
  const rate = elapsed > 0 && embedded > 0 ? embedded / elapsed : null;
  const sinceLast = Math.max(0, nowMs - Date.parse(p.at));
  const remainingMs =
    rate === null ? null : Math.max(0, Math.round((toEmbed - embedded) / rate - sinceLast));
  return {
    embedded,
    toEmbed,
    tasks: p.taskCount ?? parts.length,
    remainingMs,
    ...(p.limit ? { limit: p.limit } : {}),
  };
}

export const collectionIndexProgressOp = defineOperation({
  name: "collections.index_progress",
  readScope: "request",
  // Why system-only: the index job reports it through the admin's report
  // endpoint, which runs it as the system actor (index-job-kind.ts).
  // Unaudited: a counter the job's own row and log already show.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      pluginId: uuid,
      collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      task: z.number().int().min(0).max(63),
      /** How many tasks the attempt runs. */
      tasks: z.number().int().min(1).max(64),
      embedded: count,
      toEmbed: count,
      /** What the whole attempt embeds for the collection. */
      planned: count,
      limit: indexLimitSchema.optional(),
    })
    .strict(),
  output: z.object({ recorded: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const part = jsonbParam({ embedded: input.embedded, toEmbed: input.toEmbed });
    const limit = jsonbParam(input.limit ?? null);
    const rows = (await tx.execute(sql`
      UPDATE collection_releases
         SET progress = jsonb_build_object(
               'startedAt', COALESCE(progress->>'startedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
               'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'planned', ${input.planned}::int,
               'taskCount', ${input.tasks}::int,
               'tasks', COALESCE(progress->'tasks', '{}'::jsonb)
                          || jsonb_build_object(${String(input.task)}::text, ${part}))
             -- No key while the quota does not narrow the build.
             || jsonb_strip_nulls(jsonb_build_object('limit', ${limit}))
       WHERE run_id = ${input.runId}::uuid AND plugin_id = ${input.pluginId}::uuid
         AND collection = ${input.collection} AND state = 'pending'
      RETURNING run_id
    `)) as unknown as unknown[];
    return ok({ recorded: rows.length > 0 });
  },
});

export const collectionIndexResetProgressOp = defineOperation({
  name: "collections.index_reset_progress",
  readScope: "request",
  // Why system-only: see collections.index_progress. A wider attempt starts
  // over, so the narrower one's counts must not add to its own.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE collection_releases SET progress = NULL
       WHERE run_id = ${input.runId}::uuid AND state = 'pending' AND progress IS NOT NULL
    `);
    return ok({});
  },
});

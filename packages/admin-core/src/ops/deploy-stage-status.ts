// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1288 — `deploy.stage_status`: where the Stage runs (staging site
 * builds) stand, with an estimate of the time a running one still needs.
 *
 * Every surface that answers "where is my Stage?" reads this op: the
 * `get_stage_status` AI / MCP tool, the "still running" answers of
 * `stage_changes` and `get_quality_audit`, Settings → Deployments and the
 * Live Edit Staging menu. The estimate is computed in
 * `deploy/stage-eta.ts` against the database's clock, so it matches the
 * run's own timestamps.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  ok,
  type PhaseTiming,
  phaseTimingSchema,
  type StageStatusRun,
  stageStatusRunSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  estimateStageEta,
  failedPhaseOf,
  type StageProgress,
  stagePhaseOf,
} from "../deploy/stage-eta.js";
import { settleOrphanedRuns } from "./deploy-run-lifecycle.js";

/** How many recent successful Stages the estimate takes its median from. */
const ETA_HISTORY_RUNS = 5;

const progressSchema = z.object({
  pagesDone: z.number().int().nonnegative(),
  pagesTotal: z.number().int().nonnegative(),
  at: z.string().optional(),
  firstAt: z.string().optional(),
  firstDone: z.number().int().nonnegative().optional(),
});
const phaseTimingsSchema = z.array(phaseTimingSchema).nullable();

interface StageRunDbRow {
  id: string;
  target_name: string;
  status: "pending" | "running" | "succeeded" | "failed";
  started_at: string | Date;
  finished_at: string | Date | null;
  error_message: string | null;
  progress: unknown;
  phase_timings: unknown;
  page_count: number | string | null;
  now: string | Date;
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));

export const stageStatusOp = defineOperation({
  name: "deploy.stage_status",
  readScope: "request",
  // CLAUDE.md §11: read-only; the AI and MCP clients follow a Stage that
  // outlasted stage_changes' wait (#1288).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** One run (as `stage_changes` returned it); omitted = the newest Stage runs. */
      deployRunId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  output: z.object({ runs: z.array(stageStatusRunSchema) }),
  handler: async (_ctx, input, tx) => {
    const read = (await tx.execute(sql`
      SELECT r.id::text AS id, t.name AS target_name, r.status,
             r.started_at, r.finished_at, r.error_message,
             r.progress, r.phase_timings, r.page_count,
             clock_timestamp() AS now
        FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
       WHERE t.env = 'staging' AND r.build_kind = 'site'
         ${input.deployRunId ? sql`AND r.id = ${input.deployRunId}::uuid` : sql``}
       ORDER BY r.started_at DESC
       LIMIT ${input.deployRunId ? 1 : input.limit}
    `)) as unknown as StageRunDbRow[];
    if (read.length === 0) {
      // #1574 — a carried Stage whose build has no run yet: its carrier is
      // starting, or the Stage is merging the chats' changes.
      return ok({ runs: input.deployRunId ? await orderedStage(tx, input.deployRunId) : [] });
    }
    // #1307 — a Stage whose process died (its lease lapsed) answers failed
    // with the restart hint, not running with an estimate: the AI polled
    // such a run for hours. The row is corrected on the way.
    const rows = await settleOrphanedRuns(tx, read);

    const needsEta = rows.some((r) => r.status === "pending" || r.status === "running");
    const history = needsEta
      ? (
          (await tx.execute(sql`
            SELECT r.phase_timings
              FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
             WHERE t.env = 'staging' AND r.build_kind = 'site'
               AND r.status = 'succeeded' AND r.phase_timings IS NOT NULL
             ORDER BY r.started_at DESC
             LIMIT ${ETA_HISTORY_RUNS}
          `)) as unknown as { phase_timings: unknown }[]
        ).map((h) => phaseTimingsSchema.parse(h.phase_timings) ?? [])
      : [];

    return ok({ runs: rows.map((r) => toStageStatus(r, history)) });
  },
});

/**
 * #1574 — the Stage order `id` while it has no run row: queued (its
 * carrier is starting, or it merges the chats' changes), or failed before
 * its build started (the merge failed, the carrier never ran). Empty when
 * no Stage order has this id.
 */
async function orderedStage(
  tx: Parameters<typeof settleOrphanedRuns>[0],
  id: string,
): Promise<StageStatusRun[]> {
  // A Stage, or a rebuild of a STAGING target (deploy_staging); never a
  // production build, which is no Stage.
  const rows = (await tx.execute(sql`
    SELECT o.state, o.outcome, o.created_at, o.finished_at, clock_timestamp() AS now,
           COALESCE(o.input ->> 'targetName', 'staging') AS target_name
      FROM build_orders o
     WHERE o.id = ${id}::uuid
       AND (o.kind = 'stage'
            OR (o.kind = 'deploy.trigger'
                AND EXISTS (SELECT 1 FROM deploy_targets t
                             WHERE t.name = o.input ->> 'targetName' AND t.env = 'staging')))
  `)) as unknown as {
    state: "queued" | "running" | "done";
    outcome: { ok?: boolean; error?: unknown } | null;
    created_at: string | Date;
    finished_at: string | Date | null;
    now: string | Date;
    target_name: string;
  }[];
  const order = rows[0];
  // A Stage that succeeded has its run row; one without could only be read mid-commit.
  if (!order || order.outcome?.ok === true) return [];
  const startedAt = iso(order.created_at);
  const finishedAt = order.finished_at === null ? null : iso(order.finished_at);
  const failed = order.state === "done";
  return [
    {
      runId: id,
      targetName: order.target_name,
      status: failed ? "failed" : "queued",
      phase: failed ? "failed" : "queued",
      pagesDone: null,
      pagesTotal: null,
      startedAt,
      finishedAt,
      elapsedMs: Math.max(0, Date.parse(finishedAt ?? iso(order.now)) - Date.parse(startedAt)),
      error: failed ? describeOrderError(order.outcome?.error) : null,
      failedPhase: failed ? "before the build" : null,
      eta: null,
      etaUnavailable: failed
        ? null
        : "the Stage's build has not started yet (it merges the chats' changes, or its carrier is starting)",
    },
  ];
}

/** The failure an order recorded, in its own words. */
function describeOrderError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof e.message === "string") return e.message;
  }
  return "the Stage stopped before its build started";
}

function toStageStatus(r: StageRunDbRow, history: readonly PhaseTiming[][]): StageStatusRun {
  const progress: StageProgress | null =
    r.progress === null ? null : progressSchema.parse(r.progress);
  const startedAt = iso(r.started_at);
  const finishedAt = r.finished_at === null ? null : iso(r.finished_at);
  const nowMs = Date.parse(iso(r.now));
  const timing = { status: r.status, startedAt, progress };
  const estimate = estimateStageEta(timing, history, nowMs);
  const pageCount = r.page_count === null ? null : Number(r.page_count);
  return {
    runId: r.id,
    targetName: r.target_name,
    status: r.status === "pending" ? "queued" : r.status,
    phase: stagePhaseOf(timing),
    pagesDone: progress?.pagesDone ?? (r.status === "succeeded" ? pageCount : null),
    pagesTotal: progress?.pagesTotal ?? pageCount,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(0, Date.parse(finishedAt ?? iso(r.now)) - Date.parse(startedAt)),
    error: r.status === "failed" ? (r.error_message ?? null) : null,
    failedPhase:
      r.status === "failed" ? failedPhaseOf(phaseTimingsSchema.parse(r.phase_timings)) : null,
    eta: estimate.eta,
    etaUnavailable: estimate.etaUnavailable,
  };
}

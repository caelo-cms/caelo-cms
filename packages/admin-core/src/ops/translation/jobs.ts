// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — translation_jobs CRUD + the in-process sequential worker.
 *
 * The worker is intentionally simple: one job at a time, sequential
 * unit dispatch, polled-not-evented. A killed admin process resets
 * any `status='running'` rows back to `pending` on restart so work
 * resumes; the existing `running` unit (if any) re-runs.
 *
 * Synchronous translations of single pages don't need a job row —
 * the AI tool dispatches `translation.mode_1` / `mode_2` directly via
 * the chat-runner. Jobs exist for bulk runs ("Auto-translate
 * everything stale", per-locale, per-page-set) where the dashboard
 * needs progress + cancel + cost tracking.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { defineOperation, execute } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const jobScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all-stale") }).strict(),
  z.object({ kind: z.literal("page"), pageId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("locale"), code: z.string().min(2).max(10) }).strict(),
  z
    .object({
      kind: z.literal("pages"),
      pageIds: z.array(z.string().uuid()).min(1).max(500),
    })
    .strict(),
]);

const jobRow = z.object({
  id: z.string(),
  initiatedBy: z.string(),
  scope: z.unknown(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled", "paused"]),
  totalUnits: z.number().int().nonnegative(),
  completedUnits: z.number().int().nonnegative(),
  erroredUnits: z.number().int().nonnegative(),
  costMicrocents: z.number().int().nonnegative(),
  capMicrocents: z.number().int().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  errorSummary: z.string().nullable(),
});

const unitRow = z.object({
  id: z.string(),
  jobId: z.string(),
  pageId: z.string(),
  pageSlug: z.string(),
  targetLocale: z.string(),
  mode: z.enum(["mode_1", "mode_2"]),
  status: z.enum(["pending", "running", "completed", "errored", "skipped"]),
  variantPageId: z.string().nullable(),
  costMicrocents: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

interface DbJobRow {
  id: string;
  initiated_by: string;
  scope: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
  total_units: number;
  completed_units: number;
  errored_units: number;
  cost_microcents: number | string;
  cap_microcents: number | string | null;
  created_at: string | Date;
  finished_at: string | Date | null;
  error_summary: string | null;
}

function jobToOut(r: DbJobRow): z.infer<typeof jobRow> {
  return {
    id: r.id,
    initiatedBy: r.initiated_by,
    scope: typeof r.scope === "string" ? JSON.parse(r.scope) : r.scope,
    status: r.status,
    totalUnits: r.total_units,
    completedUnits: r.completed_units,
    erroredUnits: r.errored_units,
    costMicrocents:
      typeof r.cost_microcents === "string"
        ? Number.parseInt(r.cost_microcents, 10)
        : r.cost_microcents,
    capMicrocents:
      r.cap_microcents === null
        ? null
        : typeof r.cap_microcents === "string"
          ? Number.parseInt(r.cap_microcents, 10)
          : r.cap_microcents,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    finishedAt:
      r.finished_at === null
        ? null
        : r.finished_at instanceof Date
          ? r.finished_at.toISOString()
          : String(r.finished_at),
    errorSummary: r.error_summary,
  };
}

// ---------------------------------------------------------------------
// translation_jobs.create — pre-computes the unit list from the matrix
// and inserts translation_job_units rows up-front so the dashboard
// renders the queue immediately.
// ---------------------------------------------------------------------

export const createTranslationJobOp = defineOperation({
  name: "translation_jobs.create",
  // Why human-only: bulk runs cost real money. Owner-gate the create
  // path; AI can still propose via the start_translation_job tool, but
  // the AI call goes through the same op and lands on the validator's
  // human+system list — AI gets ActorScopeRejected.
  //
  // Update: changed to human+ai+system so the AI tool can queue jobs
  // directly (cap_microcents enforces the cost guard). The plan calls
  // for AI-proposable bulk runs.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      scope: jobScope,
      capMicrocents: z.number().int().nonnegative().nullable().optional(),
    })
    .strict(),
  output: z.object({
    jobId: z.string(),
    totalUnits: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    // Compute the unit list. Source-locale rows are NEVER targets.
    // For each scope variant, build the (page_id, target_locale, mode)
    // tuple list then INSERT.
    const localeRows = (await tx.execute(sql`
      SELECT code FROM locales WHERE code != (
        SELECT code FROM locales WHERE is_default = true LIMIT 1
      )
    `)) as unknown as { code: string }[];
    const targetLocales = localeRows.map((r) => r.code);

    const candidates: { pageId: string; targetLocale: string; mode: "mode_1" | "mode_2" }[] = [];

    if (input.scope.kind === "all-stale") {
      // Use the matrix: every (sourceSlug, locale) where status is
      // not_started or needs_update.
      const matrixRows = (await tx.execute(sql`
        WITH source_slugs AS (
          SELECT DISTINCT slug FROM pages
          WHERE translation_status = 'source' AND deleted_at IS NULL
        ),
        sources AS (
          SELECT p.id, p.slug FROM pages p
          JOIN source_slugs s ON s.slug = p.slug
          WHERE p.translation_status = 'source' AND p.deleted_at IS NULL
        )
        SELECT
          src.id::text AS source_id,
          l.code AS target_locale,
          COALESCE(pv.translation_status, 'not_started') AS status
        FROM sources src
        CROSS JOIN locales l
        LEFT JOIN pages pv
          ON pv.slug = src.slug AND pv.locale = l.code AND pv.deleted_at IS NULL
        WHERE l.code != src.id::text  -- noop guard; we filter below
      `)) as unknown as {
        source_id: string;
        target_locale: string;
        status: "source" | "up_to_date" | "needs_update" | "not_started";
      }[];
      for (const r of matrixRows) {
        if (r.status === "not_started")
          candidates.push({ pageId: r.source_id, targetLocale: r.target_locale, mode: "mode_1" });
        else if (r.status === "needs_update")
          candidates.push({ pageId: r.source_id, targetLocale: r.target_locale, mode: "mode_2" });
      }
    } else if (input.scope.kind === "page") {
      const pageId = input.scope.pageId;
      for (const target of targetLocales) {
        const variantRows = (await tx.execute(sql`
          SELECT translation_status FROM pages
          WHERE slug = (SELECT slug FROM pages WHERE id = ${pageId}::uuid)
            AND locale = ${target} AND deleted_at IS NULL LIMIT 1
        `)) as unknown as { translation_status: string }[];
        if (variantRows.length === 0) {
          candidates.push({ pageId, targetLocale: target, mode: "mode_1" });
        } else if (variantRows[0]?.translation_status === "needs_update") {
          candidates.push({ pageId, targetLocale: target, mode: "mode_2" });
        }
      }
    } else if (input.scope.kind === "locale") {
      const target = input.scope.code;
      const sourceSlugs = (await tx.execute(sql`
        SELECT id::text AS id, slug FROM pages
        WHERE translation_status = 'source' AND deleted_at IS NULL
      `)) as unknown as { id: string; slug: string }[];
      for (const s of sourceSlugs) {
        const variantRows = (await tx.execute(sql`
          SELECT translation_status FROM pages
          WHERE slug = ${s.slug} AND locale = ${target} AND deleted_at IS NULL LIMIT 1
        `)) as unknown as { translation_status: string }[];
        if (variantRows.length === 0) {
          candidates.push({ pageId: s.id, targetLocale: target, mode: "mode_1" });
        } else if (variantRows[0]?.translation_status === "needs_update") {
          candidates.push({ pageId: s.id, targetLocale: target, mode: "mode_2" });
        }
      }
    } else if (input.scope.kind === "pages") {
      for (const pid of input.scope.pageIds) {
        for (const target of targetLocales) {
          const variantRows = (await tx.execute(sql`
            SELECT translation_status FROM pages
            WHERE slug = (SELECT slug FROM pages WHERE id = ${pid}::uuid)
              AND locale = ${target} AND deleted_at IS NULL LIMIT 1
          `)) as unknown as { translation_status: string }[];
          if (variantRows.length === 0)
            candidates.push({ pageId: pid, targetLocale: target, mode: "mode_1" });
          else if (variantRows[0]?.translation_status === "needs_update")
            candidates.push({ pageId: pid, targetLocale: target, mode: "mode_2" });
        }
      }
    }

    // Insert the job row.
    const jobRows = (await tx.execute(sql`
      INSERT INTO translation_jobs (initiated_by, scope, status, total_units, cap_microcents)
      VALUES (
        ${ctx.actorId}::uuid,
        ${JSON.stringify(input.scope)}::jsonb,
        'pending',
        ${candidates.length},
        ${input.capMicrocents ?? null}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const jobId = jobRows[0]?.id;
    if (!jobId) {
      return err({
        kind: "HandlerError",
        operation: "translation_jobs.create",
        message: "job insert returned no id",
      });
    }

    for (const c of candidates) {
      await tx.execute(sql`
        INSERT INTO translation_job_units (job_id, page_id, target_locale, mode)
        VALUES (${jobId}::uuid, ${c.pageId}::uuid, ${c.targetLocale}, ${c.mode})
        ON CONFLICT (job_id, page_id, target_locale) DO NOTHING
      `);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "translation_jobs.create",
      input,
      succeeded: true,
      entityId: jobId,
      resultSummary: `scope=${input.scope.kind} units=${candidates.length}`,
    });

    return ok({ jobId, totalUnits: candidates.length });
  },
});

// ---------------------------------------------------------------------
// aggregate_active — read-only summary of in-flight work. Used by the
// translation plugin's promptContext renderer (P11.5 audit fix #4).
// ---------------------------------------------------------------------

export const aggregateActiveTranslationJobsOp = defineOperation({
  name: "translation_jobs.aggregate_active",
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    runningJobs: z.number().int().nonnegative(),
    pendingUnits: z.number().int().nonnegative(),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM translation_jobs WHERE status = 'running') AS running_jobs,
        (SELECT COUNT(*)::int FROM translation_job_units WHERE status = 'pending') AS pending_units
    `)) as unknown as { running_jobs: number; pending_units: number }[];
    const r = rows[0];
    return ok({
      runningJobs: r?.running_jobs ?? 0,
      pendingUnits: r?.pending_units ?? 0,
    });
  },
});

// ---------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------

export const listTranslationJobsOp = defineOperation({
  name: "translation_jobs.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      status: z
        .enum(["pending", "running", "completed", "failed", "cancelled", "paused", "any"])
        .default("any"),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  output: z.object({ jobs: z.array(jobRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.status === "any"
        ? sql`
            SELECT id::text AS id, initiated_by::text AS initiated_by, scope, status,
                   total_units, completed_units, errored_units,
                   cost_microcents, cap_microcents, created_at, finished_at, error_summary
            FROM translation_jobs
            ORDER BY created_at DESC
            LIMIT ${input.limit}
          `
        : sql`
            SELECT id::text AS id, initiated_by::text AS initiated_by, scope, status,
                   total_units, completed_units, errored_units,
                   cost_microcents, cap_microcents, created_at, finished_at, error_summary
            FROM translation_jobs WHERE status = ${input.status}
            ORDER BY created_at DESC
            LIMIT ${input.limit}
          `,
    )) as unknown as DbJobRow[];
    return ok({ jobs: rows.map(jobToOut) });
  },
});

export const getTranslationJobOp = defineOperation({
  name: "translation_jobs.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ jobId: z.string().uuid() }).strict(),
  output: z.object({ job: jobRow.nullable(), units: z.array(unitRow) }),
  handler: async (_ctx, input, tx) => {
    const jobRows = (await tx.execute(sql`
      SELECT id::text AS id, initiated_by::text AS initiated_by, scope, status,
             total_units, completed_units, errored_units,
             cost_microcents, cap_microcents, created_at, finished_at, error_summary
      FROM translation_jobs WHERE id = ${input.jobId}::uuid LIMIT 1
    `)) as unknown as DbJobRow[];
    const job = jobRows[0];
    if (!job) return ok({ job: null, units: [] });
    const unitsRaw = (await tx.execute(sql`
      SELECT u.id::text AS id, u.job_id::text AS job_id, u.page_id::text AS page_id,
             p.slug AS page_slug,
             u.target_locale, u.mode, u.status,
             u.variant_page_id::text AS variant_page_id,
             u.cost_microcents, u.error_message, u.started_at, u.finished_at
      FROM translation_job_units u
      JOIN pages p ON p.id = u.page_id
      WHERE u.job_id = ${input.jobId}::uuid
      ORDER BY p.slug ASC, u.target_locale ASC
    `)) as unknown as {
      id: string;
      job_id: string;
      page_id: string;
      page_slug: string;
      target_locale: string;
      mode: "mode_1" | "mode_2";
      status: "pending" | "running" | "completed" | "errored" | "skipped";
      variant_page_id: string | null;
      cost_microcents: number | string;
      error_message: string | null;
      started_at: string | Date | null;
      finished_at: string | Date | null;
    }[];
    return ok({
      job: jobToOut(job),
      units: unitsRaw.map((u) => ({
        id: u.id,
        jobId: u.job_id,
        pageId: u.page_id,
        pageSlug: u.page_slug,
        targetLocale: u.target_locale,
        mode: u.mode,
        status: u.status,
        variantPageId: u.variant_page_id,
        costMicrocents:
          typeof u.cost_microcents === "string"
            ? Number.parseInt(u.cost_microcents, 10)
            : u.cost_microcents,
        errorMessage: u.error_message,
        startedAt:
          u.started_at === null
            ? null
            : u.started_at instanceof Date
              ? u.started_at.toISOString()
              : String(u.started_at),
        finishedAt:
          u.finished_at === null
            ? null
            : u.finished_at instanceof Date
              ? u.finished_at.toISOString()
              : String(u.finished_at),
      })),
    });
  },
});

// ---------------------------------------------------------------------
// cancel + update_cap (Owner controls)
// ---------------------------------------------------------------------

export const cancelTranslationJobOp = defineOperation({
  name: "translation_jobs.cancel",
  // Why human-only: cancellation is an Owner override; AI shouldn't
  // be able to abort an in-flight bulk run it didn't queue.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ jobId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE translation_jobs
      SET status = 'cancelled', finished_at = now()
      WHERE id = ${input.jobId}::uuid AND status IN ('pending', 'running', 'paused')
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "translation_jobs.cancel",
      input,
      succeeded: true,
      entityId: input.jobId,
    });
    return ok({});
  },
});

export const updateTranslationJobCapOp = defineOperation({
  name: "translation_jobs.update_cap",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      jobId: z.string().uuid(),
      capMicrocents: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE translation_jobs
      SET cap_microcents = ${input.capMicrocents}
      WHERE id = ${input.jobId}::uuid
    `);
    // If currently paused due to cap, flip back to pending so the
    // worker re-picks it up on the next tick.
    await tx.execute(sql`
      UPDATE translation_jobs SET status = 'pending'
      WHERE id = ${input.jobId}::uuid AND status = 'paused'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "translation_jobs.update_cap",
      input,
      succeeded: true,
      entityId: input.jobId,
      resultSummary: `cap=${input.capMicrocents}`,
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// Job-level revert + publish-completed
// ---------------------------------------------------------------------

export const revertTranslationJobOp = defineOperation({
  name: "translation_jobs.revert",
  // Why human-only: deleting variants the AI just produced is the
  // cancel-button-of-last-resort; Owner-only matches the cancel +
  // update_cap ops.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ jobId: z.string().uuid() }).strict(),
  output: z.object({
    /** Mode 1 units whose variant pages were soft-deleted. */
    deletedVariants: z.number().int().nonnegative(),
    /** Mode 2 units that produced changes — they need per-page revert from the History drawer. */
    needManualRevert: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const units = (await tx.execute(sql`
      SELECT id::text AS id, mode, variant_page_id::text AS variant_page_id
      FROM translation_job_units
      WHERE job_id = ${input.jobId}::uuid AND status = 'completed'
    `)) as unknown as {
      id: string;
      mode: "mode_1" | "mode_2";
      variant_page_id: string | null;
    }[];
    let deletedVariants = 0;
    let needManualRevert = 0;
    for (const u of units) {
      if (u.mode === "mode_1" && u.variant_page_id) {
        // Soft-delete the freshly-created variant. Source page is
        // untouched; translation_status flips back to source.
        await tx.execute(sql`
          UPDATE pages SET deleted_at = now()
          WHERE id = ${u.variant_page_id}::uuid AND deleted_at IS NULL
        `);
        deletedVariants += 1;
      } else if (u.mode === "mode_2") {
        // Mode 2 overwrote module HTML in place. The per-page snapshot
        // emitted by translation.mode_2 captures the prior state — the
        // user can revert it through the Advanced History drawer.
        // We don't auto-revert here because the snapshot id isn't
        // stored on the unit; the Owner makes the per-page call.
        needManualRevert += 1;
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "translation_jobs.revert",
      input,
      succeeded: true,
      entityId: input.jobId,
      resultSummary: `deleted=${deletedVariants} need_manual=${needManualRevert}`,
    });
    return ok({ deletedVariants, needManualRevert });
  },
});

export const publishCompletedTranslationJobOp = defineOperation({
  name: "translation_jobs.publish_completed",
  // Why human-only: publishing translations is an Owner / editor act
  // (CMS_REQUIREMENTS §7.6 + §17). The variants land as draft via
  // Mode 1/2; this op walks them and flips to published in one go.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ jobId: z.string().uuid() }).strict(),
  output: z.object({
    publishedCount: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const units = (await tx.execute(sql`
      SELECT variant_page_id::text AS variant_page_id
      FROM translation_job_units
      WHERE job_id = ${input.jobId}::uuid
        AND status = 'completed'
        AND variant_page_id IS NOT NULL
    `)) as unknown as { variant_page_id: string }[];
    let publishedCount = 0;
    for (const u of units) {
      const r = (await tx.execute(sql`
        UPDATE pages SET status = 'published'
        WHERE id = ${u.variant_page_id}::uuid
          AND status = 'draft'
          AND deleted_at IS NULL
        RETURNING id
      `)) as unknown as { id: string }[];
      if (r.length > 0) publishedCount += 1;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "translation_jobs.publish_completed",
      input,
      succeeded: true,
      entityId: input.jobId,
      resultSummary: `published=${publishedCount}`,
    });
    return ok({ publishedCount });
  },
});

// ---------------------------------------------------------------------
// In-process worker
// ---------------------------------------------------------------------

let workerStarted = false;
let workerStopRequested = false;
let workerLoopPromise: Promise<void> | null = null;

interface WorkerDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly systemCtx: ExecutionContext;
  /** Polling interval when no jobs are pending. Tests use 50ms; prod 1500ms. */
  readonly idleMs?: number;
}

let workerDeps: WorkerDeps | null = null;

/**
 * Reset any rows stuck in `running` after a process restart so the
 * next worker tick re-dispatches them. Idempotent — safe to call from
 * the SvelteKit hooks.server boot path.
 */
export async function resetStuckTranslationUnits(deps: WorkerDeps): Promise<void> {
  await deps.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`
      UPDATE translation_job_units
      SET status = 'pending', started_at = NULL, finished_at = NULL
      WHERE status = 'running'
    `;
    await tx`
      UPDATE translation_jobs SET status = 'pending'
      WHERE status = 'running'
    `;
  });
}

/**
 * Start the worker loop. Idempotent — call once at boot. Stops when
 * `stopTranslationWorker()` is invoked or the process exits.
 */
export function startTranslationWorker(deps: WorkerDeps): void {
  if (workerStarted) return;
  workerStarted = true;
  workerStopRequested = false;
  workerDeps = deps;
  workerLoopPromise = workerLoop();
}

export async function stopTranslationWorker(): Promise<void> {
  workerStopRequested = true;
  await workerLoopPromise?.catch(() => undefined);
  workerStarted = false;
  workerLoopPromise = null;
  workerDeps = null;
}

async function workerLoop(): Promise<void> {
  const deps = workerDeps;
  if (!deps) return;
  const idleMs = deps.idleMs ?? 1500;
  while (!workerStopRequested) {
    try {
      const claimed = await claimNextUnit(deps);
      if (!claimed) {
        await sleep(idleMs);
        continue;
      }
      await processUnit(deps, claimed);
    } catch (e) {
      // Loop must never die. Log + sleep + continue.
      // biome-ignore lint/suspicious/noConsole: process-loop visibility
      console.error("[translation-worker] loop error", e);
      await sleep(idleMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ClaimedUnit {
  unitId: string;
  jobId: string;
  pageId: string;
  targetLocale: string;
  mode: "mode_1" | "mode_2";
}

/**
 * Atomically claim the next pending unit + flip its parent job to
 * running (if not already). Returns null when there's no work.
 *
 * Pause-on-cap is checked HERE — if the parent job's cap would be
 * exceeded by this unit, the job flips to `paused` and we return null
 * so the worker idles.
 */
async function claimNextUnit(deps: WorkerDeps): Promise<ClaimedUnit | null> {
  return deps.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

    // Pick the oldest pending unit whose parent job is pending or running.
    const rows = (await tx`
      SELECT u.id::text AS unit_id, u.job_id::text AS job_id,
             u.page_id::text AS page_id, u.target_locale, u.mode,
             j.cap_microcents, j.cost_microcents
      FROM translation_job_units u
      JOIN translation_jobs j ON j.id = u.job_id
      WHERE u.status = 'pending'
        AND j.status IN ('pending', 'running')
      ORDER BY j.created_at ASC, u.id ASC
      LIMIT 1
      FOR UPDATE OF u SKIP LOCKED
    `) as unknown as {
      unit_id: string;
      job_id: string;
      page_id: string;
      target_locale: string;
      mode: "mode_1" | "mode_2";
      cap_microcents: number | string | null;
      cost_microcents: number | string;
    }[];
    const r = rows[0];
    if (!r) return null;

    // Cap check: hard line — pause the job when accumulated spend has
    // already reached or exceeded the cap. Next-unit cost is unknown
    // until it runs, so we'd rather over-deliver one unit and pause
    // than refuse work below the cap. Raising the cap via
    // translation_jobs.update_cap flips the row back to pending so
    // the worker re-picks it up. This is "stop on overage" not
    // "stop before overage" — simpler contract, no retroactive
    // accounting per unit.
    const cap =
      r.cap_microcents === null
        ? null
        : typeof r.cap_microcents === "string"
          ? Number.parseInt(r.cap_microcents, 10)
          : r.cap_microcents;
    const spent =
      typeof r.cost_microcents === "string"
        ? Number.parseInt(r.cost_microcents, 10)
        : r.cost_microcents;
    if (cap !== null && spent >= cap) {
      await tx`
        UPDATE translation_jobs
        SET status = 'paused',
            error_summary = ${`cost cap reached: spent ${spent} / cap ${cap} (raise cap to continue)`}
        WHERE id = ${r.job_id}::uuid AND status IN ('pending', 'running')
      `;
      return null;
    }

    await tx`
      UPDATE translation_job_units
      SET status = 'running', started_at = now()
      WHERE id = ${r.unit_id}::uuid
    `;
    await tx`
      UPDATE translation_jobs SET status = 'running'
      WHERE id = ${r.job_id}::uuid AND status = 'pending'
    `;
    return {
      unitId: r.unit_id,
      jobId: r.job_id,
      pageId: r.page_id,
      targetLocale: r.target_locale,
      mode: r.mode,
    };
  });
}

async function processUnit(deps: WorkerDeps, claimed: ClaimedUnit): Promise<void> {
  const opName = claimed.mode === "mode_1" ? "translation.mode_1" : "translation.mode_2";
  const result = await execute(deps.registry, deps.adapter, deps.systemCtx, opName, {
    pageId: claimed.pageId,
    targetLocale: claimed.targetLocale,
  });
  if (result.ok) {
    const v = result.value as {
      variantPageId: string;
      costMicrocents: number;
    };
    await deps.adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        UPDATE translation_job_units
        SET status = 'completed', variant_page_id = ${v.variantPageId}::uuid,
            cost_microcents = ${v.costMicrocents}, finished_at = now()
        WHERE id = ${claimed.unitId}::uuid
      `;
      await tx`
        UPDATE translation_jobs
        SET completed_units = completed_units + 1,
            cost_microcents = cost_microcents + ${v.costMicrocents}
        WHERE id = ${claimed.jobId}::uuid
      `;
      // Mark job completed when no more pending+running remain.
      const remaining = (await tx`
        SELECT count(*)::int AS c FROM translation_job_units
        WHERE job_id = ${claimed.jobId}::uuid AND status IN ('pending', 'running')
      `) as unknown as { c: number }[];
      if ((remaining[0]?.c ?? 0) === 0) {
        await tx`
          UPDATE translation_jobs SET status = 'completed', finished_at = now()
          WHERE id = ${claimed.jobId}::uuid
        `;
      }
    });
  } else {
    const message =
      typeof result.error === "object" && result.error && "message" in result.error
        ? String((result.error as { message: unknown }).message)
        : "translation failed";
    await deps.adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        UPDATE translation_job_units
        SET status = 'errored', error_message = ${message}, finished_at = now()
        WHERE id = ${claimed.unitId}::uuid
      `;
      await tx`
        UPDATE translation_jobs
        SET errored_units = errored_units + 1, error_summary = ${message}
        WHERE id = ${claimed.jobId}::uuid
      `;
      // Mark job completed when no more pending+running remain.
      const remaining = (await tx`
        SELECT count(*)::int AS c FROM translation_job_units
        WHERE job_id = ${claimed.jobId}::uuid AND status IN ('pending', 'running')
      `) as unknown as { c: number }[];
      if ((remaining[0]?.c ?? 0) === 0) {
        await tx`
          UPDATE translation_jobs SET status = 'completed', finished_at = now()
          WHERE id = ${claimed.jobId}::uuid
        `;
      }
    });
  }
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the audit-run lifecycle:
 *
 *   quality_audits.enqueue        after a successful staging deploy, queue
 *                                 its audit and decide (from the Stage's
 *                                 classification plus the install-wide
 *                                 rules) whether Lighthouse runs, and on
 *                                 which pages.
 *   quality_audits.claim          the audit's job (#1359) takes the run it was
 *                                 started for — or resumes it, when a job
 *                                 that died is replaced — superseding it
 *                                 when staging no longer serves its build.
 *   quality_audits.sweep_unstarted the scheduler tick's backstop: audits that
 *                                 should run and have no job.
 *   quality_audits.record_result  the job reports the outcome
 *                                 (record-result.ts).
 *
 * #727 — every Stage is audited: the cheap findings checks (quality/checks)
 * read ALL pages of every staged build, SEO-only Stages included. The
 * classification (`auditNeeded`) now decides only whether Lighthouse runs
 * too; its rules and its page cap are unchanged. A run is `skipped` only
 * when staging holds no published page at all.
 *
 * An infrastructure failure always ends as `errored` with the reason on the
 * run — never as a silent pass, never as an unexplained block.
 */

import { defineOperation, type QueryError, uuidArray } from "@caelo-cms/query-api";
import { err, ok, type Result } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  type RenderFailure,
  renderFailureSchema,
  renderReportSchema,
} from "../../deploy/render-failures.js";
import { stagedBySchema } from "../../quality/chat-feedback.js";
import { withInstallRules } from "../../quality/classify.js";
import { decideGate } from "../../quality/gate.js";
import { jsonbParam } from "../../sql-helpers.js";
import { iso, stageClassificationSchema } from "./_shared.js";
import { loadAcceptances, loadGateAuditById } from "./gate-loader.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Pages Lighthouse audits per Stage: the homepage plus changed pages,
 *  capped so an audit stays within minutes (each page costs
 *  PERFORMANCE_RUNS Lighthouse runs). The findings checks read every page
 *  regardless. */
export const QUALITY_AUDIT_PAGE_CAP = 5;

/** First Performance runs per page. When they agree the best one scores
 *  the page (#874); when they disagree the runner adds confirmation runs
 *  and the median of `MEDIAN_RUNS` scores it (#1370, run-selection.ts). */
const PERFORMANCE_RUNS = 3;

/**
 * A `running` audit without a job, older than this, was claimed by the
 * in-process worker of a release before #1359, which has stopped.
 */
const STALE_RUNNING_MINUTES = 30;

/** Statuses after which a Stage counts as cleanly audited. */
const CLEAN_STATUSES = new Set(["passed", "skipped"]);

/**
 * Whether Lighthouse must look again because of the previous Stage's
 * audit. #727: problems of the findings checks alone do not count — those
 * checks re-read every page on every Stage anyway, so they need no
 * Lighthouse re-run (Lighthouse's own rules stay exactly as before).
 */
function previousNotCleanForLighthouse(previous: {
  status: string;
  lighthouse_problems: boolean;
}): boolean {
  if (CLEAN_STATUSES.has(previous.status)) return false;
  return !(previous.status === "problems" && !previous.lighthouse_problems);
}

/**
 * The latest audit of the staging deploy that ran right before this one.
 * A previous succeeded Stage WITHOUT any audit row (its enqueue failed)
 * comes back as status `missing`, so it counts as not clean.
 */
async function previousStagingAudit(
  tx: Tx,
  deployRunId: string,
): Promise<{
  id: string;
  status: string;
  target_page_ids: string[];
  lighthouse_problems: boolean;
} | null> {
  const rows = (await tx.execute(sql`
    WITH prev AS (
      SELECT r.id FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.env = 'staging' AND r.status = 'succeeded' AND r.id <> ${deployRunId}::uuid
        AND r.started_at < (SELECT started_at FROM deploy_runs WHERE id = ${deployRunId}::uuid)
      ORDER BY r.started_at DESC LIMIT 1
    )
    SELECT COALESCE(q.id::text, prev.id::text) AS id,
           COALESCE(q.status, 'missing') AS status,
           q.target_page_ids::text[] AS target_page_ids,
           COALESCE(EXISTS (
             SELECT 1 FROM quality_audit_pages qp, jsonb_array_elements(qp.problems) e
             WHERE qp.audit_run_id = q.id AND e->>'kind' <> 'check_rule'
           ), FALSE) AS lighthouse_problems
    FROM prev
    LEFT JOIN LATERAL (
      SELECT id, status, target_page_ids FROM quality_audit_runs
      WHERE deploy_run_id = prev.id ORDER BY created_at DESC LIMIT 1
    ) q ON TRUE
  `)) as unknown as {
    id: string;
    status: string;
    target_page_ids: string[] | null;
    lighthouse_problems: boolean;
  }[];
  const row = rows[0];
  return row ? { ...row, target_page_ids: row.target_page_ids ?? [] } : null;
}

/**
 * The fix round of a chat's next audit (#553; numbers the rounds of the fix
 * prompt — #771 replaced the 2-round cap with a progress rule): one more than
 * the chat's previous audit when that one left problems open AND the
 * operator asked the AI to fix them (#685: "Fix with AI" — the Stage being
 * audited is the AI's fix attempt); unchanged when they did not (a Stage
 * after "Not now" uses up no round), carried over unchanged across failed
 * or superseded audits (nothing was measured), and 0 after a clean one —
 * including problems an editor has since accepted in full. Stages outside
 * a chat have no fix loop: always 0.
 */
async function nextFixRound(tx: Tx, chatSessionId: string | null): Promise<number> {
  if (chatSessionId === null) return 0;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, status, fix_round, fix_requested_at IS NOT NULL AS fix_requested
    FROM quality_audit_runs
    WHERE chat_session_id = ${chatSessionId}::uuid
    ORDER BY created_at DESC LIMIT 1
  `)) as unknown as { id: string; status: string; fix_round: number; fix_requested: boolean }[];
  const prev = rows[0];
  if (!prev) return 0;
  if (prev.status === "problems") {
    const audit = await loadGateAuditById(tx, prev.id);
    const acceptances = await loadAcceptances(tx, audit?.pages.map((p) => p.pageId) ?? []);
    if (decideGate(audit, acceptances).open) return 0;
    return prev.fix_requested ? prev.fix_round + 1 : prev.fix_round;
  }
  if (prev.status === "passed" || prev.status === "skipped") return 0;
  return prev.fix_round;
}

/**
 * What a staging build's quality audit needs to know about the Stage that
 * made it, besides the run itself. #1319 — deploy.trigger takes it as
 * input and records the audit in the transaction that records the build
 * as succeeded, so a succeeded staging build always has its audit row.
 */
const auditRequestFields = z.object({
  /** The chat whose Stage produced the deploy; null outside a chat. */
  chatSessionId: z.string().uuid().nullable(),
  /** `quality_audits.classify_stage` output, taken BEFORE the merge.
   *  Required with a chat, null without one. */
  branch: z
    .object({
      classification: stageClassificationSchema,
      touchedPageIds: z.array(z.string().uuid()),
    })
    .strict()
    .nullable(),
  /** Pages the caller staged on purpose outside a chat (the pages
   *  list's Stage of one page); audited after the homepage. */
  pageIds: z.array(z.string().uuid()).max(50).default([]),
  /** #685 — who staged the build of a chat Stage; the chat's fix
   *  request tells the AI. Chat Stages only. */
  stagedBy: stagedBySchema.nullable().default(null),
});

/** The consistency rules every audit request obeys (one place for both schemas). */
function withAuditRequestRules<T extends z.ZodType<z.infer<typeof auditRequestFields>>>(
  schema: T,
): T {
  return schema
    .refine((v) => (v.chatSessionId === null) === (v.branch === null), {
      message: "pass the pre-merge classification exactly when a chatSessionId is given",
    })
    .refine((v) => v.stagedBy === null || v.chatSessionId !== null, {
      message: "stagedBy describes a chat Stage — pass it only with a chatSessionId",
    });
}

/** deploy.trigger's `qualityAudit` input (#1319): the audit request without the run id. */
export const stagingAuditRequestSchema = withAuditRequestRules(auditRequestFields.strict());

/** A parsed {@link stagingAuditRequestSchema}. */
export type StagingAuditRequest = z.infer<typeof stagingAuditRequestSchema>;

/** A staging build's audit row, decided before the build (#1319, deploy_runs.planned_audit). */
export const plannedAuditSchema = z
  .object({
    chatSessionId: z.string().uuid().nullable(),
    status: z.enum(["queued", "skipped"]),
    classification: stageClassificationSchema,
    targetPageIds: z.array(z.string().uuid()),
    performanceRuns: z.number().int().positive(),
    fixRound: z.number().int().nonnegative(),
    stagedBy: stagedBySchema.nullable(),
  })
  .strict();

/** A parsed {@link plannedAuditSchema}. */
export type PlannedAudit = z.infer<typeof plannedAuditSchema>;

/**
 * The audit row a staging build gets (#1319): the classification with the
 * install-wide rules, Lighthouse's target pages, the fix round. Decided
 * from the site as it is now, so deploy.start_trigger calls it before the
 * build (the build reads the same state) and stores the result on the run;
 * deploy.finish_trigger then only writes it ({@link insertPlannedAudit}).
 * The run row must exist (its `started_at` orders the Stages).
 */
export async function planStagingAudit(
  tx: Tx,
  input: z.infer<typeof stagingAuditRequestSchema> & { readonly deployRunId: string },
): Promise<PlannedAudit> {
  const firstRows = (await tx.execute(sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
        WHERE t.env = 'staging' AND r.status = 'succeeded' AND r.id <> ${input.deployRunId}::uuid
          AND r.started_at < (SELECT started_at FROM deploy_runs WHERE id = ${input.deployRunId}::uuid)
      ) AS first_stage,
      (
        SELECT max(r.started_at) FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
        WHERE t.env = 'staging' AND r.status = 'succeeded' AND r.id <> ${input.deployRunId}::uuid
          AND r.started_at < (SELECT started_at FROM deploy_runs WHERE id = ${input.deployRunId}::uuid)
      ) AS previous_stage_at
    `)) as unknown as { first_stage: boolean; previous_stage_at: string | Date | null }[];
  const firstStage = firstRows[0]?.first_stage ?? true;
  const previousStageAt = firstRows[0]?.previous_stage_at ?? null;

  const activatedPlugins =
    previousStageAt === null
      ? []
      : ((await tx.execute(sql`
            SELECT id::text AS id, slug FROM plugins
            WHERE status = 'active' AND activated_at > ${iso(previousStageAt)}::timestamptz
            ORDER BY slug
          `)) as unknown as { id: string; slug: string }[]);

  const previous = await previousStagingAudit(tx, input.deployRunId);
  const classification = withInstallRules(input.branch?.classification ?? null, {
    firstStage,
    activatedPlugins,
    previousNotClean:
      previous && previousNotCleanForLighthouse(previous)
        ? { auditRunId: previous.id, status: previous.status }
        : null,
  });

  // Lighthouse's target pages: homepage first, then the Stage's pages,
  // then pages an unclean previous audit covered — live (merged,
  // published) only.
  const candidates = new Set([
    ...(input.branch?.touchedPageIds ?? []),
    ...input.pageIds,
    ...(classification.reasons.some((r) => r.rule === "previous_not_clean")
      ? (previous?.target_page_ids ?? [])
      : []),
  ]);
  const targetRows = (await tx.execute(sql`
      WITH cand AS (
        SELECT c.id, c.ord FROM unnest(${uuidArray([...candidates])}) WITH ORDINALITY AS c(id, ord)
      )
      SELECT p.id::text AS id
      FROM pages p
      LEFT JOIN cand ON cand.id = p.id
      WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
        AND (p.current_path = '/' OR cand.id IS NOT NULL)
      ORDER BY (p.current_path = '/') DESC, cand.ord NULLS LAST, p.current_path
    `)) as unknown as { id: string }[];
  const targetPageIds = classification.auditNeeded
    ? targetRows.map((r) => r.id).slice(0, QUALITY_AUDIT_PAGE_CAP)
    : [];

  // The findings checks read every published page; with none there is
  // nothing to audit at all.
  const publishedRows = (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pages
        WHERE status = 'published' AND deleted_at IS NULL AND chat_branch_id IS NULL
      ) AS any_published
    `)) as unknown as { any_published: boolean }[];
  const anyPublished = publishedRows[0]?.any_published === true;
  const noLighthousePages = classification.auditNeeded && targetPageIds.length === 0;
  const status = anyPublished ? "queued" : "skipped";
  const finalClassification = noLighthousePages
    ? {
        ...classification,
        auditNeeded: false,
        skipped: [
          ...classification.skipped,
          anyPublished
            ? "no homepage or changed page is published for Lighthouse to audit"
            : "no published pages on staging to audit",
        ],
      }
    : classification;

  return {
    chatSessionId: input.chatSessionId,
    status,
    // Stored as JSON on the run: plain arrays.
    classification: {
      auditNeeded: finalClassification.auditNeeded,
      reasons: [...finalClassification.reasons],
      skipped: [...finalClassification.skipped],
    },
    targetPageIds,
    performanceRuns: PERFORMANCE_RUNS,
    fixRound: await nextFixRound(tx, input.chatSessionId),
    stagedBy: input.stagedBy,
  };
}

/**
 * Write a planned audit row for its deploy run and record it in the audit
 * log. Nothing is decided here: it cannot refuse what was planned.
 *
 * @param args.input - what the audit log records as the request.
 */
export async function insertPlannedAudit(
  tx: Tx,
  ctx: { readonly actorId: string; readonly requestId: string },
  args: { readonly deployRunId: string; readonly planned: PlannedAudit; readonly input: unknown },
): Promise<
  Result<
    {
      auditRunId: string;
      status: "queued" | "skipped";
      classification: PlannedAudit["classification"];
      targetPageIds: string[];
    },
    QueryError
  >
> {
  const p = args.planned;
  const inserted = (await tx.execute(sql`
    INSERT INTO quality_audit_runs
      (deploy_run_id, chat_session_id, requested_by, status, classification,
       target_page_ids, performance_runs, finished_at, fix_round, staged_by)
    VALUES (
      ${args.deployRunId}::uuid,
      -- A chat deleted while its Stage built leaves the audit without a
      -- chat (the column's ON DELETE SET NULL), never a failed insert.
      (SELECT id FROM chat_sessions WHERE id = ${p.chatSessionId}::uuid),
      ${ctx.actorId}::uuid,
      ${p.status},
      ${jsonbParam(p.classification)},
      ${uuidArray(p.targetPageIds)},
      ${p.performanceRuns},
      ${p.status === "skipped" ? sql`now()` : sql`NULL`},
      ${p.fixRound},
      ${p.stagedBy}
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const auditRunId = inserted[0]?.id;
  if (!auditRunId) {
    return err({
      kind: "HandlerError",
      operation: "quality_audits.enqueue",
      message: "could not create the audit run",
    });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "quality_audits.enqueue",
    input: args.input,
    succeeded: true,
    entityId: auditRunId,
    resultSummary: `${p.status}: ${
      p.classification.auditNeeded
        ? `lighthouse (${p.classification.reasons.map((r) => r.rule).join(",")})`
        : "page checks only"
    }`,
  });
  return ok({
    auditRunId,
    status: p.status,
    classification: p.classification,
    targetPageIds: [...p.targetPageIds],
  });
}

export const enqueueAuditOp = defineOperation({
  name: "quality_audits.enqueue",
  readScope: "request",
  // Issue #620 Part B — the AI may Stage, and the Stage flow (admin-core
  // stageChatSessions) enqueues the audit of the build it made, so the
  // flow runs this op as the AI. The classification it passes is computed
  // by quality_audits.classify_stage inside the same flow, never taken from
  // the model: no tool exposes this op's input (the parity guard lists it
  // as covered by stage_changes).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: withAuditRequestRules(
    auditRequestFields.extend({ deployRunId: z.string().uuid() }).strict(),
  ),
  output: z.object({
    auditRunId: z.string(),
    status: z.enum(["queued", "skipped"]),
    classification: stageClassificationSchema,
    targetPageIds: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    const runRows = (await tx.execute(sql`
      SELECT r.status, t.env
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.id = ${input.deployRunId}::uuid
    `)) as unknown as { status: string; env: string }[];
    const run = runRows[0];
    if (run?.env !== "staging" || run.status !== "succeeded") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.enqueue",
        message: run
          ? `deploy run ${input.deployRunId} is a ${run.status} ${run.env} run — only a succeeded staging deploy is audited`
          : `deploy run ${input.deployRunId} not found`,
        refusal: true,
      });
    }

    const planned = await planStagingAudit(tx, input);
    return insertPlannedAudit(tx, ctx, { deployRunId: input.deployRunId, planned, input });
  },
});

/**
 * A page the audit loads. #802 — the designated 404 page is built as
 * `/404.html`, never at its own path, so the audit must load it there
 * (`isNotFoundPage`); its `currentPath` stays the page's identity in reports.
 */
const claimedAuditPage = z.object({
  pageId: z.string(),
  currentPath: z.string(),
  isNotFoundPage: z.boolean(),
});

const claimedRunSchema = z.object({
  auditRunId: z.string(),
  deployRunId: z.string(),
  performanceRuns: z.number().int(),
  pageUrlStyle: z.enum(["directory", "no-extension"]),
  /** #1330 — the run's staging slot (`publish_summary.stagingLocation`); null before it. */
  stagingLocation: z.string().nullable(),
  /** `https://<staging host>`: the origin reports name; null while no host is set. */
  stagingOrigin: z.string().nullable(),
  /** The deploy target's env + out_dir: where this process wrote the
   *  build archive (served by the loopback origin on providers without a
   *  reachable staging URL). */
  env: z.string(),
  outDir: z.string(),
  /** Lighthouse's pages (empty when this Stage needs no Lighthouse). */
  pages: z.array(claimedAuditPage),
  /** #727 — every published page of the staged build, homepage first:
   *  what the findings checks read. */
  checkPages: z.array(claimedAuditPage),
  /** #1604 — the content the run's build could not render (the first of them). */
  renderFailures: z.array(renderFailureSchema),
  /** How many render failures the run recorded in all. */
  renderFailureCount: z.number().int().nonnegative(),
});

/**
 * Supersede the queued or running audits whose build staging no longer
 * serves: a newer staging build of the same target succeeded. Staging
 * serves only its newest build, so such an audit can no longer measure
 * what it was queued for; the newer Stage's audit already folded its
 * pages in (`previous_not_clean`). `only` narrows it to one audit.
 */
async function supersedeOutdated(tx: Tx, only: string | null): Promise<string[]> {
  const rows = (await tx.execute(sql`
    UPDATE quality_audit_runs q
       SET status = 'superseded', finished_at = now()
     WHERE q.status IN ('queued', 'running')
       ${only === null ? sql`` : sql`AND q.id = ${only}::uuid`}
       AND EXISTS (
         SELECT 1 FROM deploy_runs newer
         JOIN deploy_targets t ON t.id = newer.target_id
         JOIN deploy_runs mine ON mine.id = q.deploy_run_id
         WHERE t.env = 'staging' AND newer.status = 'succeeded'
           AND newer.target_id = mine.target_id AND newer.started_at > mine.started_at
       )
    RETURNING q.id::text AS id
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** #1604 — what a run recorded of the content its build could not render. */
function renderOfRun(stored: unknown): {
  renderFailures: RenderFailure[];
  renderFailureCount: number;
} {
  if (stored === null || stored === undefined) return { renderFailures: [], renderFailureCount: 0 };
  const report = renderReportSchema.parse(stored);
  return { renderFailures: report.failures, renderFailureCount: report.total };
}

/** What one claimed audit reads: its pages and where its build lies. */
async function loadClaimedRun(
  tx: Tx,
  row: { id: string; deploy_run_id: string; performance_runs: number; target_page_ids: string[] },
): Promise<Result<z.infer<typeof claimedRunSchema>, QueryError>> {
  const runInfo = (await tx.execute(sql`
    SELECT t.page_url_style, r.publish_summary->>'stagingLocation' AS staging_location,
           (SELECT 'https://' || s.staging_host FROM staging_access s
             WHERE s.id = 1 AND s.staging_host IS NOT NULL) AS staging_origin,
           t.env, t.out_dir, r.render_report
    FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
    WHERE r.id = ${row.deploy_run_id}::uuid
  `)) as unknown as {
    page_url_style: "directory" | "no-extension";
    staging_location: string | null;
    staging_origin: string | null;
    env: string;
    out_dir: string;
    render_report: unknown;
  }[];
  const info = runInfo[0];
  if (!info) {
    // Same transaction as the claim, and runs cascade with their deploy
    // run — unreachable unless the schema changed under us.
    return err({
      kind: "HandlerError",
      operation: "quality_audits.claim",
      message: `deploy run ${row.deploy_run_id} of audit ${row.id} has no target`,
      internal: true,
    });
  }
  const pages = (await tx.execute(sql`
    SELECT t.id::text AS page_id, p.current_path,
           (sd.not_found_page_id IS NOT NULL AND sd.not_found_page_id = p.id) AS is_not_found
    FROM unnest(${uuidArray(row.target_page_ids)}) WITH ORDINALITY AS t(id, ord)
    JOIN pages p ON p.id = t.id
    LEFT JOIN site_defaults sd ON sd.id = 1
    WHERE p.status = 'published' AND p.deleted_at IS NULL
    ORDER BY t.ord
  `)) as unknown as AuditPageRow[];
  // The staged build holds exactly the published pages of main
  // (deploy/draft-pages.ts); a page published or deleted since the build
  // shows up as a page staging does not serve / a dropped result.
  const checkPages = (await tx.execute(sql`
    SELECT p.id::text AS page_id, p.current_path,
           (sd.not_found_page_id IS NOT NULL AND sd.not_found_page_id = p.id) AS is_not_found
    FROM pages p
    LEFT JOIN site_defaults sd ON sd.id = 1
    WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
    ORDER BY (p.current_path = '/') DESC, p.current_path
  `)) as unknown as AuditPageRow[];
  return ok({
    auditRunId: row.id,
    deployRunId: row.deploy_run_id,
    performanceRuns: row.performance_runs,
    pageUrlStyle: info.page_url_style,
    stagingLocation: info.staging_location,
    stagingOrigin: info.staging_origin,
    env: info.env,
    outDir: info.out_dir,
    pages: pages.map(toClaimedAuditPage),
    checkPages: checkPages.map(toClaimedAuditPage),
    ...renderOfRun(info.render_report),
  });
}

export const claimAuditOp = defineOperation({
  name: "quality_audits.claim",
  // Why site-wide: a claimed audit carries every published page of the
  // staged build, which its findings checks read.
  readScope: "site",
  // Why human-only: job-internal — the quality audit's job claims the run
  // it was started for (#1359, quality/audit-job-kind.ts); humans and the
  // AI retry with quality_audits.retry or by re-staging.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ auditRunId: z.string().uuid() }).strict(),
  output: z.object({
    /**
     * `claimed`: queued until now; `resumed`: already running — a job
     * that died is being replaced, or a release before #1359 claimed it;
     * `superseded`: a newer Stage replaced its build; `settled`: it ended
     * already; `missing`: it was deleted.
     */
    state: z.enum(["claimed", "resumed", "superseded", "settled", "missing"]),
    run: claimedRunSchema.nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, status, deploy_run_id::text AS deploy_run_id, performance_runs,
             target_page_ids::text[] AS target_page_ids
      FROM quality_audit_runs WHERE id = ${input.auditRunId}::uuid
      FOR UPDATE
    `)) as unknown as {
      id: string;
      status: string;
      deploy_run_id: string;
      performance_runs: number;
      target_page_ids: string[];
    }[];
    const row = rows[0];
    if (!row) return ok({ state: "missing" as const, run: null });
    if (row.status !== "queued" && row.status !== "running") {
      return ok({ state: "settled" as const, run: null });
    }
    if ((await supersedeOutdated(tx, row.id)).length > 0) {
      return ok({ state: "superseded" as const, run: null });
    }
    if (row.status === "queued") {
      await tx.execute(sql`
        UPDATE quality_audit_runs SET status = 'running', started_at = now()
         WHERE id = ${row.id}::uuid
      `);
    }
    const run = await loadClaimedRun(tx, row);
    if (!run.ok) return run;
    return ok({
      state: row.status === "queued" ? ("claimed" as const) : ("resumed" as const),
      run: run.value,
    });
  },
});

export const sweepUnstartedAuditsOp = defineOperation({
  name: "quality_audits.sweep_unstarted",
  readScope: "request",
  // Why human-only: the scheduler tick's backstop (#1359) — it finds the
  // audits whose job was never started and starts them.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.object({
    /** Audits that should run and have no job, oldest first. */
    auditRunIds: z.array(z.string()),
    /** How many outdated ones this sweep superseded instead. */
    superseded: z.number().int(),
  }),
  handler: async (_ctx, input, tx) => {
    const superseded = await supersedeOutdated(tx, null);
    // A queued audit whose start was lost (the Stage request died right
    // after recording it, the launch failed before any lease was taken),
    // and a running one claimed by the in-process worker of a release
    // before #1359 that stopped — given that worker's own 30 minutes, so an
    // admin still on that release during the roll keeps its audit.
    const rows = (await tx.execute(sql`
      SELECT q.id::text AS id
      FROM quality_audit_runs q
      WHERE (q.status = 'queued'
             OR (q.status = 'running'
                 AND q.started_at < now() - make_interval(mins => ${STALE_RUNNING_MINUTES})))
        AND NOT EXISTS (
          SELECT 1 FROM reporting_jobs j
          WHERE j.kind = 'quality_audit' AND j.subject_id = q.id
        )
      ORDER BY q.created_at
      LIMIT ${input.limit}
    `)) as unknown as { id: string }[];
    return ok({ auditRunIds: rows.map((r) => r.id), superseded: superseded.length });
  },
});

interface AuditPageRow {
  page_id: string;
  current_path: string;
  is_not_found: boolean;
}

function toClaimedAuditPage(r: AuditPageRow): z.infer<typeof claimedAuditPage> {
  return {
    pageId: r.page_id,
    currentPath: r.current_path,
    isNotFoundPage: r.is_not_found === true,
  };
}

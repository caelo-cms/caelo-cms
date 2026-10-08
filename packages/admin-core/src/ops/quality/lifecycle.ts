// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the audit-run lifecycle:
 *
 *   quality_audits.enqueue        after a successful staging deploy, decide
 *                                 (from the Stage's classification plus the
 *                                 install-wide rules) whether to audit, and
 *                                 which pages; writes a queued or skipped run.
 *   quality_audits.claim_next     the in-admin worker takes the oldest queued
 *                                 run (multi-instance safe), superseding runs
 *                                 whose build staging no longer serves.
 *   quality_audits.record_result  the worker reports the Lighthouse outcome;
 *                                 the op applies acceptances + the ratchet,
 *                                 persists pages and baselines, and settles
 *                                 the run (passed / problems / errored).
 *
 * An infrastructure failure always ends as `errored` with the reason on the
 * run — never as a silent pass, never as an unexplained block.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { withInstallRules } from "../../quality/classify.js";
import { decideGate } from "../../quality/gate.js";
import { pageMeasurementSchema } from "../../quality/lighthouse-protocol.js";
import {
  type BaselineState,
  evaluatePage,
  type HeldBackSignal,
  type PageMeasurement,
  type QualityCategory,
} from "../../quality/ratchet.js";
import { jsonbParam } from "../../sql-helpers.js";
import { iso, json, stageClassificationSchema, uuidList } from "./_shared.js";
import { loadAcceptances, loadGateAuditById } from "./gate-loader.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Pages audited per Stage: the homepage plus changed pages, capped so an
 *  audit stays within minutes (each page costs 3 Lighthouse runs). */
export const QUALITY_AUDIT_PAGE_CAP = 5;

/** Performance runs per page (median of 3, per #553). */
const PERFORMANCE_RUNS = 3;

/** A `running` audit older than this belongs to a process that died. */
const STALE_RUNNING_MINUTES = 30;

/** Statuses after which a Stage counts as cleanly audited. */
const CLEAN_STATUSES = new Set(["passed", "skipped"]);

/**
 * The latest audit of the staging deploy that ran right before this one.
 * A previous succeeded Stage WITHOUT any audit row (its enqueue failed)
 * comes back as status `missing`, so it counts as not clean.
 */
async function previousStagingAudit(
  tx: Tx,
  deployRunId: string,
): Promise<{ id: string; status: string; target_page_ids: string[] } | null> {
  const rows = (await tx.execute(sql`
    WITH prev AS (
      SELECT r.id FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.env = 'staging' AND r.status = 'succeeded' AND r.id <> ${deployRunId}::uuid
        AND r.started_at < (SELECT started_at FROM deploy_runs WHERE id = ${deployRunId}::uuid)
      ORDER BY r.started_at DESC LIMIT 1
    )
    SELECT COALESCE(q.id::text, prev.id::text) AS id,
           COALESCE(q.status, 'missing') AS status,
           q.target_page_ids::text[] AS target_page_ids
    FROM prev
    LEFT JOIN LATERAL (
      SELECT id, status, target_page_ids FROM quality_audit_runs
      WHERE deploy_run_id = prev.id ORDER BY created_at DESC LIMIT 1
    ) q ON TRUE
  `)) as unknown as { id: string; status: string; target_page_ids: string[] | null }[];
  const row = rows[0];
  return row ? { ...row, target_page_ids: row.target_page_ids ?? [] } : null;
}

/**
 * The fix round of a chat's next audit (#553 2-round cap): one more than
 * the chat's previous audit when that one left problems open (the Stage
 * being audited is the AI's fix attempt), carried over unchanged across
 * failed or superseded audits (nothing was measured), and 0 after a clean
 * one — including problems an editor has since accepted in full. Stages
 * outside a chat have no fix loop: always 0.
 */
async function nextFixRound(tx: Tx, chatSessionId: string | null): Promise<number> {
  if (chatSessionId === null) return 0;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, status, fix_round FROM quality_audit_runs
    WHERE chat_session_id = ${chatSessionId}::uuid
    ORDER BY created_at DESC LIMIT 1
  `)) as unknown as { id: string; status: string; fix_round: number }[];
  const prev = rows[0];
  if (!prev) return 0;
  if (prev.status === "problems") {
    const audit = await loadGateAuditById(tx, prev.id);
    const acceptances = await loadAcceptances(tx, audit?.pages.map((p) => p.pageId) ?? []);
    return decideGate(audit, acceptances).open ? 0 : prev.fix_round + 1;
  }
  if (prev.status === "passed" || prev.status === "skipped") return 0;
  return prev.fix_round;
}

export const enqueueAuditOp = defineOperation({
  name: "quality_audits.enqueue",
  // Why human-only: called by the Stage flow right after the staging
  // deploy the human triggered, with the classification it computed before
  // the merge. Letting the AI enqueue would let it hand in its own
  // "nothing to audit" verdict; the AI re-runs audits by re-staging.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      deployRunId: z.string().uuid(),
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
      /** Queued by the automatic redeploy: publish when the audit's gate
       *  is open (quality_audits.settle_auto_publish). Chat-less only. */
      autoPublish: z.boolean().default(false),
    })
    .strict()
    .refine((v) => (v.chatSessionId === null) === (v.branch === null), {
      message: "pass the pre-merge classification exactly when a chatSessionId is given",
    })
    .refine((v) => !v.autoPublish || v.chatSessionId === null, {
      message: "autoPublish is for the automatic redeploy, which has no chat",
    }),
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
      });
    }

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
        previous && !CLEAN_STATUSES.has(previous.status)
          ? { auditRunId: previous.id, status: previous.status }
          : null,
    });

    // Target pages: homepage first, then the Stage's pages, then pages an
    // unclean previous audit covered — live (merged, published) only.
    const candidates = new Set([
      ...(input.branch?.touchedPageIds ?? []),
      ...input.pageIds,
      ...(classification.reasons.some((r) => r.rule === "previous_not_clean")
        ? (previous?.target_page_ids ?? [])
        : []),
    ]);
    const targetRows = (await tx.execute(sql`
      WITH cand AS (
        SELECT c.id, c.ord FROM unnest(${uuidList([...candidates])}) WITH ORDINALITY AS c(id, ord)
      )
      SELECT p.id::text AS id
      FROM pages p
      LEFT JOIN cand ON cand.id = p.id
      WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
        AND (p.current_path = '/' OR cand.id IS NOT NULL)
      ORDER BY (p.current_path = '/') DESC, cand.ord NULLS LAST, p.current_path
    `)) as unknown as { id: string }[];
    const targetPageIds = targetRows.map((r) => r.id).slice(0, QUALITY_AUDIT_PAGE_CAP);

    const noPages = classification.auditNeeded && targetPageIds.length === 0;
    const status = classification.auditNeeded && !noPages ? "queued" : "skipped";
    const finalClassification = noPages
      ? {
          ...classification,
          auditNeeded: false,
          skipped: [...classification.skipped, "no published pages on staging to audit"],
        }
      : classification;

    const fixRound = await nextFixRound(tx, input.chatSessionId);
    const inserted = (await tx.execute(sql`
      INSERT INTO quality_audit_runs
        (deploy_run_id, chat_session_id, requested_by, status, classification,
         target_page_ids, performance_runs, finished_at, fix_round, auto_publish)
      VALUES (
        ${input.deployRunId}::uuid,
        ${input.chatSessionId}::uuid,
        ${ctx.actorId}::uuid,
        ${status},
        ${jsonbParam(finalClassification)},
        ${status === "queued" ? uuidList(targetPageIds) : sql`'{}'::uuid[]`},
        ${PERFORMANCE_RUNS},
        ${status === "skipped" ? sql`now()` : sql`NULL`},
        ${fixRound},
        ${input.autoPublish}
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
      input,
      succeeded: true,
      entityId: auditRunId,
      resultSummary: `${status}: ${finalClassification.reasons.map((r) => r.rule).join(",") || "no rendering changes"}`,
    });
    return ok({
      auditRunId,
      status,
      classification: finalClassification,
      targetPageIds: status === "queued" ? targetPageIds : [],
    });
  },
});

const claimedRunSchema = z.object({
  auditRunId: z.string(),
  deployRunId: z.string(),
  performanceRuns: z.number().int(),
  pageUrlStyle: z.enum(["directory", "no-extension"]),
  /** Provider preview URL of the staged build (Firebase channels). */
  previewUrl: z.string().nullable(),
  /** The deploy target's env + out_dir: where this process wrote the
   *  build archive (served by the loopback origin on providers without a
   *  reachable staging URL). */
  env: z.string(),
  outDir: z.string(),
  pages: z.array(z.object({ pageId: z.string(), currentPath: z.string() })),
});

export const claimNextAuditOp = defineOperation({
  name: "quality_audits.claim_next",
  // Why human-only: worker-internal — only the in-admin audit worker
  // (system) takes queued runs; humans and the AI retry by re-staging.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ run: claimedRunSchema.nullable(), superseded: z.number().int() }),
  handler: async (_ctx, _input, tx) => {
    await tx.execute(sql`
      UPDATE quality_audit_runs
         SET status = 'errored', finished_at = now(), error_code = 'interrupted',
             error_message = ${`the audit was still running after ${STALE_RUNNING_MINUTES} minutes — the admin process that ran it stopped. Re-stage to audit again.`}
       WHERE status = 'running' AND started_at < now() - make_interval(mins => ${STALE_RUNNING_MINUTES})
    `);
    // Staging serves only its newest build: a queued audit of an older one
    // can no longer measure what it was queued for. The newer Stage's
    // enqueue already folded these pages in (previous_not_clean).
    const superseded = (await tx.execute(sql`
      UPDATE quality_audit_runs q
         SET status = 'superseded', finished_at = now()
       WHERE q.status = 'queued'
         AND EXISTS (
           SELECT 1 FROM deploy_runs newer
           JOIN deploy_targets t ON t.id = newer.target_id
           JOIN deploy_runs mine ON mine.id = q.deploy_run_id
           WHERE t.env = 'staging' AND newer.status = 'succeeded'
             AND newer.target_id = mine.target_id AND newer.started_at > mine.started_at
         )
      RETURNING q.id
    `)) as unknown as { id: string }[];
    const claimed = (await tx.execute(sql`
      UPDATE quality_audit_runs
         SET status = 'running', started_at = now()
       WHERE id = (
         SELECT id FROM quality_audit_runs WHERE status = 'queued'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
      RETURNING id::text AS id, deploy_run_id::text AS deploy_run_id, performance_runs,
                target_page_ids::text[] AS target_page_ids
    `)) as unknown as {
      id: string;
      deploy_run_id: string;
      performance_runs: number;
      target_page_ids: string[];
    }[];
    const row = claimed[0];
    if (!row) return ok({ run: null, superseded: superseded.length });
    const runInfo = (await tx.execute(sql`
      SELECT t.page_url_style, r.publish_summary->>'previewUrl' AS preview_url, t.env, t.out_dir
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.id = ${row.deploy_run_id}::uuid
    `)) as unknown as {
      page_url_style: "directory" | "no-extension";
      preview_url: string | null;
      env: string;
      out_dir: string;
    }[];
    const info = runInfo[0];
    if (!info) {
      // Same transaction as the claim, and runs cascade with their deploy
      // run — unreachable unless the schema changed under us.
      return err({
        kind: "HandlerError",
        operation: "quality_audits.claim_next",
        message: `deploy run ${row.deploy_run_id} of audit ${row.id} has no target`,
      });
    }
    const pages = (await tx.execute(sql`
      SELECT t.id::text AS page_id, p.current_path
      FROM unnest(${uuidList(row.target_page_ids)}) WITH ORDINALITY AS t(id, ord)
      JOIN pages p ON p.id = t.id
      WHERE p.status = 'published' AND p.deleted_at IS NULL
      ORDER BY t.ord
    `)) as unknown as { page_id: string; current_path: string }[];
    return ok({
      run: {
        auditRunId: row.id,
        deployRunId: row.deploy_run_id,
        performanceRuns: row.performance_runs,
        pageUrlStyle: info.page_url_style,
        previewUrl: info.preview_url,
        env: info.env,
        outDir: info.out_dir,
        pages: pages.map((p) => ({ pageId: p.page_id, currentPath: p.current_path })),
      },
      superseded: superseded.length,
    });
  },
});

const auditedPageInput = z
  .object({
    pageId: z.string().uuid(),
    url: z.string(),
    finalUrl: z.string().optional(),
    measurement: pageMeasurementSchema,
    performanceRuns: z.array(z.number().int().min(0).max(100)).min(1),
  })
  .strict();

const pageErrorInput = z
  .object({
    pageId: z.string().uuid(),
    url: z.string(),
    code: z.string(),
    message: z.string().min(1),
  })
  .strict();

async function loadRatchetState(
  tx: Tx,
  auditRunId: string,
  pageId: string,
): Promise<{
  baselines: Partial<Record<QualityCategory, BaselineState>>;
  accepted: Set<string>;
  previousHeldBack: Set<string>;
}> {
  const baselineRows = (await tx.execute(sql`
    SELECT category, baseline, below_streak FROM quality_baselines WHERE page_id = ${pageId}::uuid
  `)) as unknown as { category: QualityCategory; baseline: number; below_streak: number }[];
  const baselines: Partial<Record<QualityCategory, BaselineState>> = {};
  for (const b of baselineRows) {
    baselines[b.category] = { baseline: b.baseline, belowStreak: b.below_streak };
  }
  const acceptedRows = (await tx.execute(sql`
    SELECT audit_id FROM quality_acceptances
    WHERE page_id = ${pageId}::uuid AND kind = 'finding' AND revoked_at IS NULL
  `)) as unknown as { audit_id: string }[];
  const prevRows = (await tx.execute(sql`
    SELECT qp.held_back FROM quality_audit_pages qp
    WHERE qp.page_id = ${pageId}::uuid AND qp.audit_run_id <> ${auditRunId}::uuid
      AND qp.status <> 'errored'
    ORDER BY qp.created_at DESC LIMIT 1
  `)) as unknown as { held_back: unknown }[];
  const previousHeldBack = new Set<string>();
  for (const h of json<HeldBackSignal[]>(prevRows[0]?.held_back ?? [])) {
    if (h.kind === "performance_finding") previousHeldBack.add(h.auditId);
  }
  return { baselines, accepted: new Set(acceptedRows.map((r) => r.audit_id)), previousHeldBack };
}

export const recordAuditResultOp = defineOperation({
  name: "quality_audits.record_result",
  // Why human-only: worker-internal — the Lighthouse outcome comes from the
  // in-admin audit worker (system); nobody else may write scores.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      auditRunId: z.string().uuid(),
      /** Staging origin the pages were fetched from (null when it could
       *  not even be resolved). */
      baseUrl: z.string().nullable(),
      outcome: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("completed"),
            pages: z.array(auditedPageInput),
            pageErrors: z.array(pageErrorInput),
          })
          .strict(),
        z
          .object({ kind: z.literal("failed"), code: z.string(), message: z.string().min(1) })
          .strict(),
      ]),
    })
    .strict(),
  output: z.object({
    /** `discarded`: the run no longer exists (its deploy run was deleted
     *  while the audit ran), so there is nothing to record on. */
    status: z.enum(["passed", "problems", "errored", "discarded"]),
    problemCount: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    const runRows = (await tx.execute(sql`
      SELECT status FROM quality_audit_runs WHERE id = ${input.auditRunId}::uuid FOR UPDATE
    `)) as unknown as { status: string }[];
    const current = runRows[0];
    if (!current) return ok({ status: "discarded" as const, problemCount: 0 });
    if (current.status !== "running") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.record_result",
        message: `audit run ${input.auditRunId} is ${current.status}, not running — results are only recorded once, by the worker that claimed it`,
      });
    }

    let status: "passed" | "problems" | "errored";
    let problemCount = 0;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let vanished: string[] = [];

    if (input.outcome.kind === "failed") {
      status = "errored";
      errorCode = input.outcome.code;
      errorMessage = input.outcome.message;
    } else {
      // A page deleted outright while the audit ran has nothing left to
      // gate; its measurement is dropped and named in the audit record.
      const ids = [
        ...input.outcome.pages.map((p) => p.pageId),
        ...input.outcome.pageErrors.map((e) => e.pageId),
      ];
      const existing = new Set(
        (
          (await tx.execute(sql`
            SELECT id::text AS id FROM pages WHERE id = ANY(${uuidList(ids)})
          `)) as unknown as { id: string }[]
        ).map((r) => r.id),
      );
      vanished = ids.filter((id) => !existing.has(id));
      const pages = input.outcome.pages.filter((p) => existing.has(p.pageId));
      const pageErrors = input.outcome.pageErrors.filter((e) => existing.has(e.pageId));
      for (const page of pages) {
        const state = await loadRatchetState(tx, input.auditRunId, page.pageId);
        const evaluation = evaluatePage({
          measurement: page.measurement as PageMeasurement,
          baselines: state.baselines,
          acceptedAuditIds: state.accepted,
          previousHeldBackFindings: state.previousHeldBack,
        });
        problemCount += evaluation.problems.length;
        await tx.execute(sql`
          INSERT INTO quality_audit_pages
            (audit_run_id, page_id, url, status, scores, performance_runs,
             failing_audits, problems, held_back)
          VALUES (
            ${input.auditRunId}::uuid, ${page.pageId}::uuid, ${page.finalUrl ?? page.url},
            ${evaluation.problems.length > 0 ? "problems" : "clean"},
            ${jsonbParam(page.measurement.scores)},
            ARRAY(SELECT jsonb_array_elements_text(${jsonbParam(page.performanceRuns)})::int),
            ${jsonbParam(page.measurement.failingAudits)},
            ${jsonbParam(evaluation.problems)},
            ${jsonbParam(evaluation.heldBack)}
          )
        `);
        for (const [category, next] of Object.entries(evaluation.nextBaselines)) {
          await tx.execute(sql`
            INSERT INTO quality_baselines (page_id, category, baseline, below_streak, updated_by_run)
            VALUES (${page.pageId}::uuid, ${category}, ${next.baseline}, ${next.belowStreak},
                    ${input.auditRunId}::uuid)
            ON CONFLICT (page_id, category) DO UPDATE
              SET baseline = EXCLUDED.baseline, below_streak = EXCLUDED.below_streak,
                  updated_at = now(), updated_by_run = EXCLUDED.updated_by_run
          `);
          // Ratchet: once the page scores above an accepted drop, that
          // acceptance is spent — a later drop below the new baseline must
          // block again, not hide behind the old acceptance.
          await tx.execute(sql`
            UPDATE quality_acceptances
               SET revoked_at = now(), revoked_by = ${ctx.actorId}::uuid
             WHERE page_id = ${page.pageId}::uuid AND kind = 'score' AND category = ${category}
               AND revoked_at IS NULL AND accepted_score < ${next.baseline}
          `);
        }
      }
      for (const e of pageErrors) {
        await tx.execute(sql`
          INSERT INTO quality_audit_pages
            (audit_run_id, page_id, url, status, error_code, error_message)
          VALUES (${input.auditRunId}::uuid, ${e.pageId}::uuid, ${e.url}, 'errored', ${e.code}, ${e.message})
        `);
      }
      if (pageErrors.length > 0) {
        status = "errored";
        errorCode = "page-failed";
        errorMessage = `${pageErrors.length} page(s) could not be audited: ${pageErrors
          .map((e) => `${e.url} (${e.code}: ${e.message.slice(0, 160)})`)
          .join("; ")}`;
      } else if (pages.length === 0) {
        status = "errored";
        errorCode = "pages-deleted";
        errorMessage =
          "every audited page was deleted while the audit ran — Stage again to audit the current pages";
      } else {
        status = problemCount > 0 ? "problems" : "passed";
      }
    }

    await tx.execute(sql`
      UPDATE quality_audit_runs
         SET status = ${status}, finished_at = now(), base_url = ${input.baseUrl},
             error_code = ${errorCode}, error_message = ${errorMessage},
             problem_count = ${problemCount}
       WHERE id = ${input.auditRunId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.record_result",
      input: { auditRunId: input.auditRunId, outcome: input.outcome.kind },
      succeeded: true,
      entityId: input.auditRunId,
      resultSummary: `${
        errorMessage
          ? `${status}: ${errorMessage.slice(0, 200)}`
          : `${status}: ${problemCount} problem(s)`
      }${vanished.length > 0 ? `; dropped deleted page(s) ${vanished.join(", ")}` : ""}`,
    });
    return ok({ status, problemCount });
  },
});

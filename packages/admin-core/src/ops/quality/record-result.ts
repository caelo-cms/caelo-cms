// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 / #727 — `quality_audits.record_result`: the audit worker
 * reports one audit run's outcome and the op settles it.
 *
 * A completed audit carries two parts:
 * - Lighthouse (`pages`, `pageErrors`): per audited page the scores and
 *   failing audits, evaluated by the per-category ratchet (ratchet.ts)
 *   exactly as before #727. Empty when the Stage needed no Lighthouse.
 * - the findings checks (`checks`): every finding on every page of the
 *   staged build, evaluated by the per-rule ratchet (checks/evaluate.ts).
 *
 * Both land in the same rows: `quality_audit_pages.problems` holds a page's
 * Lighthouse AND check problems (that is what the gate, the chat offer and
 * the fix skill read), `check_findings` every finding as measured. A page
 * gets a row when Lighthouse audited it or a check found something on it;
 * clean check-only pages leave no row. Site-wide findings and problems go
 * to `quality_audit_runs.checks`.
 *
 * Anything that kept a part from measuring — a Lighthouse page error, a
 * page staging did not serve, a check that failed — ends the run as
 * `errored` with the reasons: never a silent pass (CLAUDE.md §2).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { type CheckRuleProblem, evaluateCheckFindings } from "../../quality/checks/evaluate.js";
import type { Finding } from "../../quality/checks/findings.js";
import { checksOutcomeSchema } from "../../quality/checks/outcome.js";
import { pageMeasurementSchema } from "../../quality/lighthouse-protocol.js";
import {
  type BaselineState,
  evaluatePage,
  type HeldBackSignal,
  type PageMeasurement,
  type QualityCategory,
  type QualityProblem,
} from "../../quality/ratchet.js";
import { jsonbParam } from "../../sql-helpers.js";
import { json, uuidList } from "./_shared.js";
import {
  applyAcceptanceTightening,
  loadCheckAcceptances,
  measuredCheckIdsFor,
  summarizeChecks,
} from "./record-checks.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

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

/** Persist the Lighthouse ratchet of one page; returns its problems. */
async function ratchetLighthousePage(
  tx: Tx,
  auditRunId: string,
  actorId: string,
  page: z.infer<typeof auditedPageInput>,
): Promise<{ problems: readonly QualityProblem[]; heldBack: readonly HeldBackSignal[] }> {
  const state = await loadRatchetState(tx, auditRunId, page.pageId);
  const evaluation = evaluatePage({
    measurement: page.measurement as PageMeasurement,
    baselines: state.baselines,
    acceptedAuditIds: state.accepted,
    previousHeldBackFindings: state.previousHeldBack,
  });
  for (const [category, next] of Object.entries(evaluation.nextBaselines)) {
    await tx.execute(sql`
      INSERT INTO quality_baselines (page_id, category, baseline, below_streak, updated_by_run)
      VALUES (${page.pageId}::uuid, ${category}, ${next.baseline}, ${next.belowStreak},
              ${auditRunId}::uuid)
      ON CONFLICT (page_id, category) DO UPDATE
        SET baseline = EXCLUDED.baseline, below_streak = EXCLUDED.below_streak,
            updated_at = now(), updated_by_run = EXCLUDED.updated_by_run
    `);
    // Ratchet: once the page scores above an accepted drop, that
    // acceptance is spent — a later drop below the new baseline must
    // block again, not hide behind the old acceptance.
    await tx.execute(sql`
      UPDATE quality_acceptances
         SET revoked_at = now(), revoked_by = ${actorId}::uuid
       WHERE page_id = ${page.pageId}::uuid AND kind = 'score' AND category = ${category}
         AND revoked_at IS NULL AND accepted_score < ${next.baseline}
    `);
  }
  return { problems: evaluation.problems, heldBack: evaluation.heldBack };
}

/** One `quality_audit_pages` row, Lighthouse and check parts merged. */
interface PageRow {
  readonly pageId: string;
  url: string;
  lighthouse: z.infer<typeof auditedPageInput> | null;
  lighthouseError: z.infer<typeof pageErrorInput> | null;
  problems: QualityProblem[];
  heldBack: readonly HeldBackSignal[];
  findings: Finding[];
}

async function insertPageRow(tx: Tx, auditRunId: string, row: PageRow): Promise<void> {
  const failed = row.lighthouseError;
  const status = failed ? "errored" : row.problems.length > 0 ? "problems" : "clean";
  await tx.execute(sql`
    INSERT INTO quality_audit_pages
      (audit_run_id, page_id, url, status, scores, performance_runs,
       failing_audits, metrics, problems, held_back, check_findings, error_code, error_message)
    VALUES (
      ${auditRunId}::uuid, ${row.pageId}::uuid, ${row.url}, ${status},
      ${row.lighthouse ? jsonbParam(row.lighthouse.measurement.scores) : null},
      ARRAY(SELECT jsonb_array_elements_text(${jsonbParam(row.lighthouse?.performanceRuns ?? [])})::int),
      ${jsonbParam(row.lighthouse?.measurement.failingAudits ?? [])},
      ${row.lighthouse ? jsonbParam(row.lighthouse.measurement.metrics) : null},
      ${jsonbParam(row.problems)},
      ${jsonbParam(row.heldBack)},
      ${jsonbParam(row.findings)},
      ${failed?.code ?? null}, ${failed?.message ?? null}
    )
  `);
}

const completedOutcome = z
  .object({
    kind: z.literal("completed"),
    /** Lighthouse results; empty when this Stage needed no Lighthouse. */
    pages: z.array(auditedPageInput),
    pageErrors: z.array(pageErrorInput),
    /** #727 — the findings checks over every page of the staged build. */
    checks: checksOutcomeSchema,
  })
  .strict();

function failureOf(
  lighthouseErrors: readonly z.infer<typeof pageErrorInput>[],
  checkErrors: readonly { message: string }[],
): { code: string; message: string } | null {
  const parts: string[] = [];
  if (lighthouseErrors.length > 0) {
    parts.push(
      `${lighthouseErrors.length} page(s) could not be audited: ${lighthouseErrors
        .map((e) => `${e.url} (${e.code}: ${e.message.slice(0, 160)})`)
        .join("; ")}`,
    );
  }
  if (checkErrors.length > 0) {
    const shown = checkErrors.slice(0, 5).map((e) => e.message.slice(0, 240));
    const more = checkErrors.length > 5 ? `; and ${checkErrors.length - 5} more` : "";
    parts.push(`the page checks could not finish: ${shown.join("; ")}${more}`);
  }
  if (parts.length === 0) return null;
  return {
    code: lighthouseErrors.length > 0 ? "page-failed" : "check-failed",
    message: parts.join(". "),
  };
}

/**
 * Record a completed audit. Returns the run's status, problem count, error
 * (if any), and the page ids dropped because they were deleted meanwhile.
 */
async function recordCompleted(
  tx: Tx,
  auditRunId: string,
  actorId: string,
  outcome: z.infer<typeof completedOutcome>,
): Promise<{
  status: "passed" | "problems" | "errored";
  problemCount: number;
  failure: { code: string; message: string } | null;
  vanished: string[];
}> {
  const checks = outcome.checks;
  // A page deleted outright while the audit ran has nothing left to gate;
  // its measurement is dropped and named in the audit record.
  const named = [
    ...outcome.pages.map((p) => p.pageId),
    ...outcome.pageErrors.map((e) => e.pageId),
    ...checks.pages.map((p) => p.pageId),
  ];
  const existing = new Set(
    (
      (await tx.execute(sql`
        SELECT id::text AS id FROM pages WHERE id = ANY(${uuidList(named)})
      `)) as unknown as { id: string }[]
    ).map((r) => r.id),
  );
  const vanished = [...new Set(named.filter((id) => !existing.has(id)))];
  const checkedPages = checks.pages.filter((p) => existing.has(p.pageId));
  const findings = checks.findings.filter((f) => f.pageId === undefined || existing.has(f.pageId));
  const checkErrors = checks.errors.filter((e) => e.pageId === undefined || existing.has(e.pageId));

  const rows = new Map<string, PageRow>();
  const rowFor = (pageId: string, url: string): PageRow => {
    let row = rows.get(pageId);
    if (!row) {
      row = {
        pageId,
        url,
        lighthouse: null,
        lighthouseError: null,
        problems: [],
        heldBack: [],
        findings: [],
      };
      rows.set(pageId, row);
    }
    return row;
  };

  for (const page of outcome.pages.filter((p) => existing.has(p.pageId))) {
    const row = rowFor(page.pageId, page.finalUrl ?? page.url);
    row.lighthouse = page;
    const lh = await ratchetLighthousePage(tx, auditRunId, actorId, page);
    row.problems.push(...lh.problems);
    row.heldBack = lh.heldBack;
  }
  const lighthouseErrors = outcome.pageErrors.filter((e) => existing.has(e.pageId));
  for (const e of lighthouseErrors) rowFor(e.pageId, e.url).lighthouseError = e;

  // The per-rule ratchet of the findings checks.
  const accepted = await loadCheckAcceptances(
    tx,
    checkedPages.map((p) => p.pageId),
  );
  const urlOf = new Map(checkedPages.map((p) => [p.pageId, p.url]));
  const findingsByPage = new Map<string, Finding[]>();
  const siteFindings: Finding[] = [];
  for (const f of findings) {
    if (f.pageId === undefined) {
      siteFindings.push(f);
      continue;
    }
    const list = findingsByPage.get(f.pageId);
    if (list) list.push(f);
    else findingsByPage.set(f.pageId, [f]);
  }
  for (const [pageId, pageFindings] of findingsByPage) {
    const row = rowFor(pageId, urlOf.get(pageId) ?? rows.get(pageId)?.url ?? "");
    row.findings = pageFindings;
    row.problems.push(...evaluateCheckFindings(pageFindings, accepted.counts(pageId)));
  }
  const siteProblems: CheckRuleProblem[] = evaluateCheckFindings(
    siteFindings,
    accepted.counts(null),
  );
  await applyAcceptanceTightening(tx, actorId, {
    accepted,
    checkedPageIds: checkedPages.map((p) => p.pageId),
    findingsByPage,
    siteFindings,
    measured: (pageId) => measuredCheckIdsFor(checks, pageId),
  });

  let problemCount = siteProblems.length;
  for (const row of rows.values()) {
    problemCount += row.problems.length;
    await insertPageRow(tx, auditRunId, row);
  }
  await tx.execute(sql`
    UPDATE quality_audit_runs
       SET checks = ${jsonbParam(
         summarizeChecks(checks, {
           pagesChecked: checkedPages.length,
           findings,
           siteFindings,
           siteProblems,
           errors: checkErrors,
         }),
       )}
     WHERE id = ${auditRunId}::uuid
  `);

  const failure = failureOf(lighthouseErrors, checkErrors);
  if (failure) return { status: "errored", problemCount, failure, vanished };
  if (named.length > 0 && existing.size === 0) {
    return {
      status: "errored",
      problemCount,
      failure: {
        code: "pages-deleted",
        message:
          "every audited page was deleted while the audit ran — Stage again to audit the current pages",
      },
      vanished,
    };
  }
  return {
    status: problemCount > 0 ? "problems" : "passed",
    problemCount,
    failure: null,
    vanished,
  };
}

export const recordAuditResultOp = defineOperation({
  name: "quality_audits.record_result",
  // Why human-only: worker-internal — the audit outcome comes from the
  // in-admin audit worker (system); nobody else may write scores or findings.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      auditRunId: z.string().uuid(),
      /** Staging origin the pages were fetched from (null when it could
       *  not even be resolved). */
      baseUrl: z.string().nullable(),
      outcome: z.discriminatedUnion("kind", [
        completedOutcome,
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

    const settled =
      input.outcome.kind === "failed"
        ? {
            status: "errored" as const,
            problemCount: 0,
            failure: { code: input.outcome.code, message: input.outcome.message },
            vanished: [] as string[],
          }
        : await recordCompleted(tx, input.auditRunId, ctx.actorId, input.outcome);

    await tx.execute(sql`
      UPDATE quality_audit_runs
         SET status = ${settled.status}, finished_at = now(), base_url = ${input.baseUrl},
             error_code = ${settled.failure?.code ?? null},
             error_message = ${settled.failure?.message ?? null},
             problem_count = ${settled.problemCount}
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
        settled.failure
          ? `${settled.status}: ${settled.failure.message.slice(0, 200)}`
          : `${settled.status}: ${settled.problemCount} problem(s)`
      }${settled.vanished.length > 0 ? `; dropped deleted page(s) ${settled.vanished.join(", ")}` : ""}`,
    });
    return ok({ status: settled.status, problemCount: settled.problemCount });
  },
});

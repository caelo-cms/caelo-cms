// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — read surfaces of the quality gate (CLAUDE.md §11: every
 * domain has list + get, open to every actor kind, so the AI can plan its
 * fixes without asking the operator).
 *
 *   quality_audits.list       audit runs, newest first, filterable.
 *   quality_audits.get        one run with every page's scores, findings,
 *                             problems and held-back signals.
 *   quality_acceptances.list  accepted findings / score drops per page.
 *
 * Pages that were deleted (soft delete) drop out of every read: their
 * acceptances no longer apply anywhere (#553 §5).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { QualityCategory } from "../../quality/ratchet.js";
import {
  auditRunStatusSchema,
  categorySchema,
  failingAuditSchema,
  heldBackSchema,
  iso,
  json,
  problemSchema,
  stageClassificationSchema,
} from "./_shared.js";

export const runSummarySchema = z.object({
  id: z.string(),
  deployRunId: z.string(),
  chatSessionId: z.string().nullable(),
  status: auditRunStatusSchema,
  classification: stageClassificationSchema,
  pageCount: z.number().int(),
  problemCount: z.number().int(),
  baseUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** #553 fix loop: 0 for a chat's first audit of a problem chain, then 1, 2. */
  fixRound: z.number().int(),
  /** The failed audit this run retries, if any. */
  retryOf: z.string().nullable(),
  /** An editor's recorded "publish anyway" over this failed audit. */
  publishOverride: z.object({ by: z.string(), reason: z.string(), at: z.string() }).nullable(),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

export interface RunDbRow {
  id: string;
  deploy_run_id: string;
  chat_session_id: string | null;
  status: RunSummary["status"];
  classification: unknown;
  page_count: number;
  problem_count: number;
  base_url: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  fix_round: number;
  retry_of: string | null;
  publish_override_by: string | null;
  publish_override_reason: string | null;
  publish_override_at: string | Date | null;
}

export const RUN_COLUMNS = sql`
  q.id::text AS id, q.deploy_run_id::text AS deploy_run_id,
  q.chat_session_id::text AS chat_session_id, q.status, q.classification,
  cardinality(q.target_page_ids) AS page_count, q.problem_count, q.base_url,
  q.error_code, q.error_message, q.created_at, q.started_at, q.finished_at,
  q.fix_round, q.retry_of::text AS retry_of, q.publish_override_by::text AS publish_override_by,
  q.publish_override_reason, q.publish_override_at`;

export function toRunSummary(r: RunDbRow): RunSummary {
  return {
    id: r.id,
    deployRunId: r.deploy_run_id,
    chatSessionId: r.chat_session_id,
    status: r.status,
    classification: json<RunSummary["classification"]>(r.classification),
    pageCount: Number(r.page_count),
    problemCount: Number(r.problem_count),
    baseUrl: r.base_url,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: iso(r.created_at),
    startedAt: r.started_at === null ? null : iso(r.started_at),
    finishedAt: r.finished_at === null ? null : iso(r.finished_at),
    fixRound: Number(r.fix_round),
    retryOf: r.retry_of,
    publishOverride:
      r.publish_override_by !== null && r.publish_override_at !== null
        ? {
            by: r.publish_override_by,
            reason: r.publish_override_reason ?? "",
            at: iso(r.publish_override_at),
          }
        : null,
  };
}

export const listAuditsOp = defineOperation({
  name: "quality_audits.list",
  // CLAUDE.md §11: read-only, open to every actor — the AI checks whether
  // its last Stage's audit finished and how it ended.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid().optional(),
      deployRunId: z.string().uuid().optional(),
      status: auditRunStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).default(20),
    })
    .strict(),
  output: z.object({ runs: z.array(runSummarySchema) }),
  handler: async (_ctx, input, tx) => {
    const filters: SQL[] = [];
    if (input.chatSessionId)
      filters.push(sql` AND q.chat_session_id = ${input.chatSessionId}::uuid`);
    if (input.deployRunId) filters.push(sql` AND q.deploy_run_id = ${input.deployRunId}::uuid`);
    if (input.status) filters.push(sql` AND q.status = ${input.status}`);
    const rows = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS}
      FROM quality_audit_runs q
      WHERE TRUE${sql.join(filters, sql``)}
      ORDER BY q.created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as RunDbRow[];
    return ok({ runs: rows.map(toRunSummary) });
  },
});

const auditPageSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string(),
  pagePath: z.string(),
  url: z.string(),
  status: z.enum(["clean", "problems", "errored"]),
  scores: z.record(categorySchema, z.number().int()).nullable(),
  baselines: z.record(categorySchema, z.number().int()),
  performanceRuns: z.array(z.number().int()),
  failingAudits: z.array(failingAuditSchema),
  problems: z.array(problemSchema),
  heldBack: z.array(heldBackSchema),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const getAuditOp = defineOperation({
  name: "quality_audits.get",
  // CLAUDE.md §11: read-only — the AI reads the full findings to fix them.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** A specific run. Omit both ids for the newest audit run. */
      auditRunId: z.string().uuid().optional(),
      /** The newest audit of this staging deploy run. */
      deployRunId: z.string().uuid().optional(),
      /** The newest audit of this chat's Stages. */
      chatSessionId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ run: runSummarySchema.nullable(), pages: z.array(auditPageSchema) }),
  handler: async (_ctx, input, tx) => {
    const given = [input.auditRunId, input.deployRunId, input.chatSessionId].filter(
      (v) => v !== undefined,
    );
    if (given.length > 1) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.get",
        message: "pass at most one of auditRunId, deployRunId, chatSessionId",
      });
    }
    const where = input.auditRunId
      ? sql`q.id = ${input.auditRunId}::uuid`
      : input.deployRunId
        ? sql`q.deploy_run_id = ${input.deployRunId}::uuid`
        : input.chatSessionId
          ? sql`q.chat_session_id = ${input.chatSessionId}::uuid`
          : sql`TRUE`;
    const runRows = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS} FROM quality_audit_runs q
      WHERE ${where}
      ORDER BY q.created_at DESC LIMIT 1
    `)) as unknown as RunDbRow[];
    const runRow = runRows[0];
    if (!runRow) {
      if (input.auditRunId) {
        return err({
          kind: "HandlerError",
          operation: "quality_audits.get",
          message: `audit run ${input.auditRunId} not found — call list_quality_audits for valid ids`,
        });
      }
      return ok({ run: null, pages: [] });
    }
    const pageRows = (await tx.execute(sql`
      SELECT qp.page_id::text AS page_id, p.title, p.current_path, qp.url, qp.status, qp.scores,
             qp.performance_runs, qp.failing_audits, qp.problems, qp.held_back,
             qp.error_code, qp.error_message,
             COALESCE((SELECT jsonb_object_agg(b.category, b.baseline)
                         FROM quality_baselines b WHERE b.page_id = qp.page_id), '{}'::jsonb) AS baselines
      FROM quality_audit_pages qp
      JOIN pages p ON p.id = qp.page_id
      WHERE qp.audit_run_id = ${runRow.id}::uuid AND p.deleted_at IS NULL
      ORDER BY (p.current_path = '/') DESC, p.current_path
    `)) as unknown as {
      page_id: string;
      title: string;
      current_path: string;
      url: string;
      status: "clean" | "problems" | "errored";
      scores: unknown;
      performance_runs: number[] | null;
      failing_audits: unknown;
      problems: unknown;
      held_back: unknown;
      error_code: string | null;
      error_message: string | null;
      baselines: unknown;
    }[];
    const fullBaselines = (stored: Record<string, number>) => ({
      performance: stored.performance ?? 100,
      accessibility: stored.accessibility ?? 100,
      "best-practices": stored["best-practices"] ?? 100,
      seo: stored.seo ?? 100,
    });
    return ok({
      run: toRunSummary(runRow),
      pages: pageRows.map((r) => ({
        pageId: r.page_id,
        pageTitle: r.title,
        pagePath: r.current_path,
        url: r.url,
        status: r.status,
        scores: r.scores === null ? null : json<Record<QualityCategory, number>>(r.scores),
        baselines: fullBaselines(json<Record<string, number>>(r.baselines)),
        performanceRuns: (r.performance_runs ?? []).map(Number),
        failingAudits: json<z.infer<typeof failingAuditSchema>[]>(r.failing_audits),
        problems: json<z.infer<typeof problemSchema>[]>(r.problems),
        heldBack: json<z.infer<typeof heldBackSchema>[]>(r.held_back),
        errorCode: r.error_code,
        errorMessage: r.error_message,
      })),
    });
  },
});

const acceptanceSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  pageTitle: z.string(),
  pagePath: z.string(),
  kind: z.enum(["finding", "score"]),
  auditId: z.string().nullable(),
  category: categorySchema.nullable(),
  acceptedScore: z.number().int().nullable(),
  reason: z.string(),
  acceptedBy: z.string(),
  acceptedAt: z.string(),
  auditRunId: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const listAcceptancesOp = defineOperation({
  name: "quality_acceptances.list",
  // CLAUDE.md §11: read-only — the AI checks what an editor already
  // accepted before asking again.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid().optional(),
      /** Substring of the Lighthouse audit id, the reason, or the page path. */
      query: z.string().max(200).optional(),
      includeRevoked: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  output: z.object({ acceptances: z.array(acceptanceSchema) }),
  handler: async (_ctx, input, tx) => {
    const filters: SQL[] = [];
    if (input.pageId) filters.push(sql` AND a.page_id = ${input.pageId}::uuid`);
    if (!input.includeRevoked) filters.push(sql` AND a.revoked_at IS NULL`);
    if (input.query && input.query.length > 0) {
      const like = `%${input.query}%`;
      filters.push(
        sql` AND (a.audit_id ILIKE ${like} OR a.reason ILIKE ${like} OR p.current_path ILIKE ${like})`,
      );
    }
    const rows = (await tx.execute(sql`
      SELECT a.id::text AS id, a.page_id::text AS page_id, p.title, p.current_path, a.kind,
             a.audit_id, a.category, a.accepted_score, a.reason,
             a.accepted_by::text AS accepted_by, a.accepted_at, a.audit_run_id::text AS audit_run_id, a.revoked_at
      FROM quality_acceptances a
      JOIN pages p ON p.id = a.page_id AND p.deleted_at IS NULL
      WHERE TRUE${sql.join(filters, sql``)}
      ORDER BY a.accepted_at DESC
      LIMIT ${input.limit}
    `)) as unknown as {
      id: string;
      page_id: string;
      title: string;
      current_path: string;
      kind: "finding" | "score";
      audit_id: string | null;
      category: z.infer<typeof categorySchema> | null;
      accepted_score: number | null;
      reason: string;
      accepted_by: string;
      accepted_at: string | Date;
      audit_run_id: string | null;
      revoked_at: string | Date | null;
    }[];
    return ok({
      acceptances: rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        pageTitle: r.title,
        pagePath: r.current_path,
        kind: r.kind,
        auditId: r.audit_id,
        category: r.category,
        acceptedScore: r.accepted_score,
        reason: r.reason,
        acceptedBy: r.accepted_by,
        acceptedAt: iso(r.accepted_at),
        auditRunId: r.audit_run_id,
        revokedAt: r.revoked_at === null ? null : iso(r.revoked_at),
      })),
    });
  },
});

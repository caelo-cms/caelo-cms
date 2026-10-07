// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — ops around the Publish-live gate:
 *
 *   quality_audits.gate_status               may the staged build go live, and
 *                                            if not, why and what next.
 *   quality_audits.retry                     re-run a failed (or missing)
 *                                            audit of the staged build.
 *   quality_audits.chat_status               the newest audit of a chat plus
 *                                            the message the chat should get.
 *   quality_audits.claim_chat_notification   claim that message exactly once.
 *   quality_audits.publish_anyway            an editor's recorded decision to
 *                                            publish over a FAILED audit.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { chatFeedbackFor } from "../../quality/chat-feedback.js";
import type { QualityProblem } from "../../quality/ratchet.js";
import { promoteDeployOp } from "../deploy.js";
import { json } from "./_shared.js";
import { latestSucceededRun, publishGateForRun } from "./gate-loader.js";
import { enqueueAuditOp } from "./lifecycle.js";
import { RUN_COLUMNS, type RunDbRow, runSummarySchema, toRunSummary } from "./read.js";

const gateSchema = z.object({
  open: z.boolean(),
  state: z.enum(["clean", "accepted", "overridden", "missing", "running", "problems", "errored"]),
  auditRunId: z.string().nullable(),
  message: z.string(),
  canPublishAnyway: z.boolean(),
  openProblemCount: z.number().int(),
});

const gateStatusOutput = z.object({
  /** The staged deploy run Publish would ship (null: nothing staged). */
  deployRunId: z.string().nullable(),
  gate: gateSchema.nullable(),
});

async function gateFor(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  fromTarget: string,
): Promise<z.infer<typeof gateStatusOutput>> {
  const run = await latestSucceededRun(tx, fromTarget);
  if (!run) return { deployRunId: null, gate: null };
  const g = await publishGateForRun(tx, run.id);
  return {
    deployRunId: run.id,
    gate: {
      open: g.open,
      state: g.state,
      auditRunId: g.auditRunId,
      message: g.message,
      canPublishAnyway: g.canPublishAnyway,
      openProblemCount: g.openProblems.length,
    },
  };
}

export const gateStatusOp = defineOperation({
  name: "quality_audits.gate_status",
  // CLAUDE.md §11: read-only — the AI checks whether Publish live is open
  // before suggesting it, and reads the next step when it is not.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ fromTarget: z.string().min(1).default("staging") }).strict(),
  output: gateStatusOutput,
  handler: async (_ctx, input, tx) => ok(await gateFor(tx, input.fromTarget)),
});

export const retryAuditOp = defineOperation({
  name: "quality_audits.retry",
  // Routine and harmless: re-measures the build that is already staged and
  // changes nothing on the site, so the AI may run it too (§11 default).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ fromTarget: z.string().min(1).default("staging") }).strict(),
  output: z.object({ auditRunId: z.string(), status: z.enum(["queued", "skipped"]) }),
  handler: async (ctx, input, tx) => {
    const run = await latestSucceededRun(tx, input.fromTarget);
    if (run?.env !== "staging") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.retry",
        message: `nothing staged on '${input.fromTarget}' to audit — Stage first`,
      });
    }
    const latest = (await tx.execute(sql`
      SELECT id::text AS id, status, chat_session_id::text AS chat_session_id, classification,
             target_page_ids::text[] AS target_page_ids, performance_runs, fix_round
      FROM quality_audit_runs WHERE deploy_run_id = ${run.id}::uuid
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as {
      id: string;
      status: string;
      chat_session_id: string | null;
      classification: unknown;
      target_page_ids: string[];
      performance_runs: number;
      fix_round: number;
    }[];
    const prev = latest[0];
    if (!prev || prev.status === "superseded") {
      // Never audited (e.g. staged before the gate existed, or the enqueue
      // failed): audit it like a Stage outside a chat.
      const r = await enqueueAuditOp.handler(
        ctx,
        { deployRunId: run.id, chatSessionId: null, branch: null, pageIds: [] },
        tx,
      );
      if (!r.ok) return r;
      return ok({ auditRunId: r.value.auditRunId, status: r.value.status });
    }
    if (prev.status !== "errored") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.retry",
        message:
          prev.status === "queued" || prev.status === "running"
            ? "the quality check of the staged build is still running — wait for it instead of retrying"
            : `the quality check of the staged build ended '${prev.status}', it did not fail — to re-check after fixes, Stage again`,
      });
    }
    const inserted = (await tx.execute(sql`
      INSERT INTO quality_audit_runs
        (deploy_run_id, chat_session_id, requested_by, status, classification,
         target_page_ids, performance_runs, fix_round, retry_of)
      SELECT deploy_run_id, chat_session_id, ${ctx.actorId}::uuid, 'queued', classification,
             target_page_ids, performance_runs, fix_round, id
      FROM quality_audit_runs WHERE id = ${prev.id}::uuid
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const auditRunId = inserted[0]?.id;
    if (!auditRunId) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.retry",
        message: "could not queue the retry",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.retry",
      input,
      succeeded: true,
      entityId: auditRunId,
      resultSummary: `retry of failed audit ${prev.id}`,
    });
    return ok({ auditRunId, status: "queued" as const });
  },
});

const feedbackSchema = z.object({ kind: z.enum(["note", "ai-turn"]), text: z.string() }).nullable();

export const chatStatusOp = defineOperation({
  name: "quality_audits.chat_status",
  // Read-only; the chat panel polls it. Open to every actor (§11).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    audit: runSummarySchema.nullable(),
    /** Whether the chat was already told about `audit`. */
    notified: z.boolean(),
    /** What the chat should be told about `audit` (null while running). */
    feedback: feedbackSchema,
    /** The site-wide Publish gate (the staged build may come from another chat). */
    deployRunId: z.string().nullable(),
    gate: gateSchema.nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS}, q.chat_notified_at
      FROM quality_audit_runs q
      WHERE q.chat_session_id = ${input.chatSessionId}::uuid
      ORDER BY q.created_at DESC LIMIT 1
    `)) as unknown as (RunDbRow & { chat_notified_at: string | Date | null })[];
    const gate = await gateFor(tx, "staging");
    const row = rows[0];
    if (!row) return ok({ audit: null, notified: false, feedback: null, ...gate });
    const audit = toRunSummary(row);
    const pageRows = (await tx.execute(sql`
      SELECT p.current_path, qp.problems
      FROM quality_audit_pages qp JOIN pages p ON p.id = qp.page_id
      WHERE qp.audit_run_id = ${audit.id}::uuid AND qp.status = 'problems'
      ORDER BY (p.current_path = '/') DESC, p.current_path
    `)) as unknown as { current_path: string; problems: unknown }[];
    const feedback = chatFeedbackFor({
      status: audit.status,
      fixRound: audit.fixRound,
      problemCount: pageRows.reduce((n, r) => n + json<QualityProblem[]>(r.problems).length, 0),
      problemPagePaths: pageRows.map((r) => r.current_path),
      errorCode: audit.errorCode,
      errorMessage: audit.errorMessage,
      skippedBecause: audit.classification.skipped,
    });
    return ok({ audit, notified: row.chat_notified_at !== null, feedback, ...gate });
  },
});

export const claimChatNotificationOp = defineOperation({
  name: "quality_audits.claim_chat_notification",
  // Why human-only: the chat panel of the operator claims the message it
  // is about to post; claiming it from anywhere else would swallow it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ auditRunId: z.string().uuid() }).strict(),
  output: z.object({ claimed: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE quality_audit_runs SET chat_notified_at = now()
      WHERE id = ${input.auditRunId}::uuid AND chat_notified_at IS NULL
        AND status IN ('passed', 'problems', 'errored', 'skipped')
      RETURNING id
    `)) as unknown as { id: string }[];
    return ok({ claimed: rows.length === 1 });
  },
});

export const publishAnywayOp = defineOperation({
  name: "quality_audits.publish_anyway",
  // Why human-only: this IS the human decision the gate exists to obtain
  // (#553: never the AI on its own). The AI reaches it only through the
  // approval card of publish_despite_failed_audit, applied as the human.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      auditRunId: z.string().uuid(),
      reason: z.string().trim().min(3).max(500),
      fromTarget: z.string().min(1).default("staging"),
      toTarget: z.string().min(1).default("production"),
    })
    .strict(),
  output: z.object({ fromRunId: z.string(), toRunId: z.string(), buildId: z.string() }),
  handler: async (ctx, input, tx) => {
    const run = await latestSucceededRun(tx, input.fromTarget);
    const gate = run ? await publishGateForRun(tx, run.id) : null;
    if (!gate || gate.auditRunId !== input.auditRunId || gate.state !== "errored") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.publish_anyway",
        message: !gate
          ? `nothing staged on '${input.fromTarget}' — Stage first`
          : gate.state === "errored"
            ? `audit ${input.auditRunId} is not the failed check of the current staged build (that is ${gate.auditRunId}) — call quality_audits.gate_status for the current one`
            : `publish anyway only applies to a FAILED quality check; the staged build's check is '${gate.state}'. ${gate.message}`,
      });
    }
    await tx.execute(sql`
      UPDATE quality_audit_runs
         SET publish_override_by = ${ctx.actorId}::uuid,
             publish_override_reason = ${input.reason},
             publish_override_at = now()
       WHERE id = ${input.auditRunId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.publish_anyway",
      input,
      succeeded: true,
      entityId: input.auditRunId,
      resultSummary: `published over a failed quality check: ${input.reason}`,
    });
    // The decision stands even if the copy below fails (it is about the
    // audit, not the copy): a later Publish live then passes the gate as
    // "overridden", and promote records its own failure on its deploy run.
    return promoteDeployOp.handler(
      ctx,
      { fromTarget: input.fromTarget, toTarget: input.toTarget },
      tx,
    );
  },
});

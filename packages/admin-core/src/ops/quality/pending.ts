// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the human-confirmed quality decisions, on the standard
 * propose/execute engine (CLAUDE.md §11.A) behind the in-chat approval
 * cards:
 *
 *   quality_audits.propose_accept          accept findings / score drops on
 *                                          pages (any editor may approve).
 *   quality_audits.propose_publish_anyway  publish over a FAILED audit.
 *   quality_audits.execute_proposal        apply — human/system only.
 *   quality_audits.reject_proposal / list_pending.
 *
 * The AI can propose but never apply: the SDK pauses on the approval card,
 * and only the human's click runs execute_proposal (as that human, who is
 * then recorded as `accepted_by` / `publish_override_by`).
 */

import { defineOperation, type QueryError } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus, type Result } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import type { QualityProblem } from "../../quality/ratchet.js";
import { jsonbParam } from "../../sql-helpers.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { actorHasPermission } from "./_permissions.js";
import { categorySchema, iso, json } from "./_shared.js";
import { publishAnywayOp } from "./gate.js";
import { latestSucceededRun, publishGateForRun } from "./gate-loader.js";

/**
 * The audit the gate currently decides on (the newest audit of the build
 * staging serves). Acceptances only make sense against it: accepting from
 * an older audit could lower a baseline a newer, better audit raised.
 */
async function currentGateAuditId(tx: Tx): Promise<string | null> {
  const run = await latestSucceededRun(tx, "staging");
  if (!run) return null;
  return (await publishGateForRun(tx, run.id)).auditRunId;
}

function staleAuditMessage(auditRunId: string, current: string | null): string {
  return current
    ? `audit ${auditRunId} is not the current quality check of the staged build (that is ${current}) — call get_quality_audit and accept from the current one`
    : "nothing is staged — Stage first";
}

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** One thing to accept, named by the page's path so the editor reads it
 *  on the approval card as-is ("/about: image-alt"). */
const acceptItemSchema = z.union([
  z.object({ pagePath: z.string().min(1).max(500), auditId: z.string().min(1).max(200) }).strict(),
  z.object({ pagePath: z.string().min(1).max(500), category: categorySchema }).strict(),
]);

export const proposeAcceptInput = z
  .object({
    /** The audit the findings come from (get_quality_audit shows its id). */
    auditRunId: z.string().uuid(),
    /** Findings (Lighthouse audit id) or score drops (category) per page. */
    items: z.array(acceptItemSchema).min(1).max(50),
    /** Why these are acceptable — shown to the editor and stored. */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

type ProposeAcceptInput = z.infer<typeof proposeAcceptInput>;

interface ResolvedItem {
  readonly pageId: string;
  readonly pagePath: string;
  readonly kind: "finding" | "score";
  readonly auditId: string | null;
  readonly category: string | null;
  /** For a score drop: the measured score that becomes the baseline. */
  readonly score: number | null;
  readonly label: string;
}

/**
 * Check every item against the audit's recorded problems: only a real,
 * current problem can be accepted (an AI typo must not mint an
 * acceptance for something that never failed).
 */
async function resolveItems(
  tx: Tx,
  input: ProposeAcceptInput,
): Promise<{ ok: true; items: ResolvedItem[] } | { ok: false; message: string }> {
  const rows = (await tx.execute(sql`
    SELECT qp.page_id::text AS page_id, p.current_path, qp.problems
    FROM quality_audit_pages qp JOIN pages p ON p.id = qp.page_id AND p.deleted_at IS NULL
    WHERE qp.audit_run_id = ${input.auditRunId}::uuid
  `)) as unknown as { page_id: string; current_path: string; problems: unknown }[];
  if (rows.length === 0) {
    return {
      ok: false,
      message: `audit ${input.auditRunId} has no audited pages — call get_quality_audit for the current audit id`,
    };
  }
  const byPath = new Map(rows.map((r) => [r.current_path, r]));
  const resolved: ResolvedItem[] = [];
  for (const item of input.items) {
    const page = byPath.get(item.pagePath);
    if (!page) {
      return {
        ok: false,
        message: `${item.pagePath} was not audited in ${input.auditRunId} — audited pages: ${rows.map((r) => r.current_path).join(", ")}`,
      };
    }
    const problems = json<QualityProblem[]>(page.problems);
    if ("auditId" in item) {
      const p = problems.find((x) => x.kind === "failing_audit" && x.auditId === item.auditId);
      if (p?.kind !== "failing_audit") {
        return {
          ok: false,
          message: `'${item.auditId}' is not a problem on ${page.current_path} in this audit — its problems: ${problems.map((x) => (x.kind === "failing_audit" ? x.auditId : `${x.category} score`)).join(", ") || "none"}`,
        };
      }
      resolved.push({
        pageId: page.page_id,
        pagePath: page.current_path,
        kind: "finding",
        auditId: item.auditId,
        category: null,
        score: null,
        label: `${page.current_path}: ${p.auditId} — ${p.title}`,
      });
    } else {
      const p = problems.find(
        (x) => x.kind === "score_below_baseline" && x.category === item.category,
      );
      if (p?.kind !== "score_below_baseline") {
        return {
          ok: false,
          message: `the ${item.category} score is not below its baseline on ${page.current_path} in this audit — nothing to accept`,
        };
      }
      resolved.push({
        pageId: page.page_id,
        pagePath: page.current_path,
        kind: "score",
        auditId: null,
        category: item.category,
        score: p.score,
        label: `${page.current_path}: ${item.category} score ${p.score} (baseline ${p.baseline} → ${p.score})`,
      });
    }
  }
  return { ok: true, items: resolved };
}

async function queueProposal(
  tx: Tx,
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "accept" | "publish_anyway",
  auditRunId: string,
  payload: unknown,
  preview: Record<string, unknown>,
  opName: string,
): Promise<Result<{ proposalId: string; preview: Record<string, unknown> }, QueryError>> {
  const payloadHash = await hashProposalPayload({ kind, payload });
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO quality_pending_actions
        (kind, proposed_by, audit_run_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (${kind}, ${ctx.actorId}::uuid, ${auditRunId}::uuid, ${jsonbParam(payload)},
              ${jsonbParam(preview)}, 'pending',
              ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`}, ${payloadHash})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
  } catch (e) {
    if (isDuplicatePendingError(e)) {
      return err({ kind: "HandlerError", operation: opName, message: DUPLICATE_PROPOSAL_MESSAGE });
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return err({ kind: "HandlerError", operation: opName, message: "insert returned no id" });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: `kind=${kind}`,
  });
  return ok({ proposalId, preview });
}

const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

export const proposeAcceptOp = defineOperation({
  name: "quality_audits.propose_accept",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeAcceptInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const current = await currentGateAuditId(tx);
    if (current !== input.auditRunId) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.propose_accept",
        message: staleAuditMessage(input.auditRunId, current),
      });
    }
    const r = await resolveItems(tx, input);
    if (!r.ok) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.propose_accept",
        message: r.message,
      });
    }
    const preview = {
      kind: "accept",
      reason: input.reason,
      accepts: r.items.map((i) => i.label),
      note: "Applies only to these pages; the same finding on another page still blocks.",
    };
    return queueProposal(
      tx,
      ctx,
      "accept",
      input.auditRunId,
      input,
      preview,
      "quality_audits.propose_accept",
    );
  },
});

export const proposePublishAnywayInput = z
  .object({
    /** The FAILED audit of the staged build (quality_audits.gate_status). */
    auditRunId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const proposePublishAnywayOp = defineOperation({
  name: "quality_audits.propose_publish_anyway",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposePublishAnywayInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT status, error_code, error_message FROM quality_audit_runs
      WHERE id = ${input.auditRunId}::uuid
    `)) as unknown as { status: string; error_code: string | null; error_message: string | null }[];
    const run = rows[0];
    if (run?.status !== "errored") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.propose_publish_anyway",
        message: run
          ? `audit ${input.auditRunId} did not fail (it is '${run.status}'): publish anyway is only for a failed quality check — fix or accept problems instead`
          : `audit ${input.auditRunId} not found — call quality_audits.gate_status for the current one`,
      });
    }
    const preview = {
      kind: "publish_anyway",
      failedCheck: `${run.error_code ?? "error"}: ${run.error_message ?? ""}`,
      reason: input.reason,
      effect: "Publishes the staged build live now, without a quality result.",
    };
    return queueProposal(
      tx,
      ctx,
      "publish_anyway",
      input.auditRunId,
      input,
      preview,
      "quality_audits.propose_publish_anyway",
    );
  },
});

/** Write the acceptances of a confirmed proposal as `ctx` (the human). */
async function applyAcceptances(
  tx: Tx,
  ctx: { actorId: string },
  input: ProposeAcceptInput,
): Promise<{ ok: true; accepted: number } | { ok: false; message: string }> {
  // Re-resolve at apply time: the page may have been deleted, or the
  // audit superseded, between the card and the click.
  const r = await resolveItems(tx, input);
  if (!r.ok) return r;
  let accepted = 0;
  for (const item of r.items) {
    if (item.kind === "finding") {
      const ins = (await tx.execute(sql`
        INSERT INTO quality_acceptances (page_id, kind, audit_id, reason, accepted_by, audit_run_id)
        VALUES (${item.pageId}::uuid, 'finding', ${item.auditId}, ${input.reason},
                ${ctx.actorId}::uuid, ${input.auditRunId}::uuid)
        ON CONFLICT (page_id, audit_id) WHERE kind = 'finding' AND revoked_at IS NULL DO NOTHING
        RETURNING id
      `)) as unknown as { id: string }[];
      accepted += ins.length;
      continue;
    }
    // A score acceptance replaces the page's previous one for the category
    // (kept as history, revoked) and lowers the baseline to the accepted
    // score — the ratchet then guards that level (#553 §5).
    await tx.execute(sql`
      UPDATE quality_acceptances SET revoked_at = now(), revoked_by = ${ctx.actorId}::uuid
      WHERE page_id = ${item.pageId}::uuid AND kind = 'score' AND category = ${item.category}
        AND revoked_at IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO quality_acceptances
        (page_id, kind, category, accepted_score, reason, accepted_by, audit_run_id)
      VALUES (${item.pageId}::uuid, 'score', ${item.category}, ${item.score}, ${input.reason},
              ${ctx.actorId}::uuid, ${input.auditRunId}::uuid)
    `);
    await tx.execute(sql`
      INSERT INTO quality_baselines (page_id, category, baseline, below_streak, updated_by_run)
      VALUES (${item.pageId}::uuid, ${item.category}, ${item.score}, 0, ${input.auditRunId}::uuid)
      ON CONFLICT (page_id, category) DO UPDATE
        SET baseline = EXCLUDED.baseline, below_streak = 0, updated_at = now(),
            updated_by_run = EXCLUDED.updated_by_run
    `);
    accepted += 1;
  }
  return { ok: true, accepted };
}

export const executeQualityProposalOp = defineOperation({
  name: "quality_audits.execute_proposal",
  // Why human-only: the click the §11.A gate exists to obtain.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    kind: z.enum(["accept", "publish_anyway"]),
    accepted: z.number().int().optional(),
    toRunId: z.string().optional(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT kind, payload, status FROM quality_pending_actions
      WHERE id = ${input.proposalId}::uuid FOR UPDATE
    `)) as unknown as { kind: "accept" | "publish_anyway"; payload: unknown; status: string }[];
    const row = rows[0];
    if (row?.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.execute_proposal",
        message: row ? `proposal is already ${row.status}` : "proposal not found",
      });
    }
    // The approval card applies this op as the chat's operator without a
    // route in front, so the persisted kind decides the permission here.
    const needed = row.kind === "accept" ? "content.write" : "deploy.trigger";
    if (!(await actorHasPermission(tx, ctx, needed))) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.execute_proposal",
        message: `this decision needs the ${needed} permission — ask an editor who has it`,
      });
    }
    let result: { kind: "accept" | "publish_anyway"; accepted?: number; toRunId?: string };
    if (row.kind === "accept") {
      const payload = proposeAcceptInput.parse(parsePayload(row.payload));
      const current = await currentGateAuditId(tx);
      if (current !== payload.auditRunId) {
        await tx.execute(sql`
          UPDATE quality_pending_actions
             SET status = 'superseded', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
                 decision_reason = 'a newer quality check replaced the audit it was made for'
           WHERE id = ${input.proposalId}::uuid
        `);
        return err({
          kind: "HandlerError",
          operation: "quality_audits.execute_proposal",
          message: staleAuditMessage(payload.auditRunId, current),
        });
      }
      const applied = await applyAcceptances(tx, ctx, payload);
      if (!applied.ok) {
        return err({
          kind: "HandlerError",
          operation: "quality_audits.execute_proposal",
          message: applied.message,
        });
      }
      result = { kind: "accept", accepted: applied.accepted };
    } else {
      const payload = proposePublishAnywayInput.parse(parsePayload(row.payload));
      const published = await publishAnywayOp.handler(
        ctx,
        {
          auditRunId: payload.auditRunId,
          reason: payload.reason,
          fromTarget: "staging",
          toTarget: "production",
        },
        tx,
      );
      if (!published.ok) return published;
      result = { kind: "publish_anyway", toRunId: published.value.toRunId };
    }
    await tx.execute(sql`
      UPDATE quality_pending_actions
         SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
       WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary:
        result.kind === "accept"
          ? `accepted ${result.accepted} quality finding(s)`
          : `published anyway (run ${result.toRunId})`,
    });
    return ok(result);
  },
});

export const rejectQualityProposalOp = defineOperation({
  name: "quality_audits.reject_proposal",
  // Why human-only: rejecting is the human half of the §11.A decision.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({ proposalId: z.string().uuid(), reason: z.string().min(1).max(500).optional() })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE quality_pending_actions
         SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
             decision_reason = ${input.reason ?? null}
       WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

export const listPendingQualityProposalsOp = defineOperation({
  name: "quality_audits.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["accept", "publish_anyway"]),
        proposedBy: z.string(),
        auditRunId: z.string().nullable(),
        preview: z.record(z.string(), z.unknown()),
        status: proposalStatus,
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by,
             audit_run_id::text AS audit_run_id, preview, status, created_at
      FROM quality_pending_actions WHERE status = 'pending'
      ORDER BY created_at DESC LIMIT ${input.limit ?? 50}
    `)) as unknown as {
      id: string;
      kind: "accept" | "publish_anyway";
      proposed_by: string;
      audit_run_id: string | null;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
    }[];
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        auditRunId: r.audit_run_id,
        preview: json<Record<string, unknown>>(r.preview),
        status: r.status,
        createdAt: iso(r.created_at),
      })),
    });
  },
});

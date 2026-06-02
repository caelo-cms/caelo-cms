// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.19 — deploy.{propose_promote, propose_rollback, execute_proposal,
 * reject_proposal, list_pending}. First exemplar of CLAUDE.md §11.A's
 * propose/execute pattern for hard-to-revert ops.
 *
 *   AI says "publish staging to production"
 *   → AI tool → deploy.propose_promote (AI-callable)
 *     → row at status='pending' in deploy_pending_actions
 *     → AI replies "I prepared a proposal — click Approve at /security/deployments/pending"
 *   Operator clicks Approve
 *   → /security/deployments/pending form action → deploy.execute_proposal (human-only)
 *     → reads the row, dispatches the underlying op (deploy.promote / .rollback)
 *     → marks row status='applied'
 *
 * The execute-side stays human-only so AI cannot self-approve. The
 * preview is computed at propose time so the operator's click decision
 * has full blast-radius context (build id, file count, etc.).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { promoteDeployOp, rollbackDeployOp } from "./deploy.js";

const proposalRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["promote", "rollback"]),
  proposedBy: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus.exclude(["superseded"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  appliedRunId: z.string().nullable(),
});

interface ProposalDbRow {
  id: string;
  kind: "promote" | "rollback";
  proposed_by: string;
  payload: unknown;
  preview: unknown;
  status: Exclude<ProposalStatus, "superseded">;
  created_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
  decision_reason: string | null;
  applied_run_id: string | null;
}

function rowToOutput(r: ProposalDbRow): z.infer<typeof proposalRowSchema> {
  const created = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
  const decided = r.decided_at
    ? r.decided_at instanceof Date
      ? r.decided_at.toISOString()
      : String(r.decided_at)
    : null;
  return {
    id: r.id,
    kind: r.kind,
    proposedBy: r.proposed_by,
    payload: r.payload as Record<string, unknown>,
    preview: r.preview as Record<string, unknown>,
    status: r.status,
    createdAt: created,
    decidedAt: decided,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    appliedRunId: r.applied_run_id,
  };
}

const proposePromoteInput = z
  .object({
    fromTarget: z.string().min(1).max(80),
    toTarget: z.string().min(1).max(80),
    repoRoot: z.string().optional(),
  })
  .strict();

export const proposeDeployPromoteOp = defineOperation({
  name: "deploy.propose_promote",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposePromoteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    if (input.fromTarget === input.toTarget) {
      return err({
        kind: "HandlerError",
        operation: "deploy.propose_promote",
        message: "fromTarget and toTarget must differ",
      });
    }
    // Compute preview: pull the latest succeeded build from fromTarget
    // so the Owner sees what will be promoted before clicking Approve.
    const fromRunRows = (await tx.execute(sql`
      SELECT
        r.id::text          AS run_id,
        r.build_id          AS build_id,
        r.page_count        AS page_count,
        r.file_count        AS file_count,
        r.started_at        AS started_at,
        t.name              AS target_name
      FROM deploy_runs r
      JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.name = ${input.fromTarget}
        AND r.status = 'succeeded'
        AND r.build_id IS NOT NULL
      ORDER BY r.started_at DESC
      LIMIT 1
    `)) as unknown as Array<{
      run_id: string;
      build_id: string | null;
      page_count: number | null;
      file_count: number | null;
      started_at: string | Date;
      target_name: string;
    }>;
    const from = fromRunRows[0];
    if (!from?.build_id) {
      return err({
        kind: "HandlerError",
        operation: "deploy.propose_promote",
        message: `no succeeded build to promote from "${input.fromTarget}". Run \`deploy.trigger\` for ${input.fromTarget} first.`,
      });
    }
    const preview = {
      fromTarget: input.fromTarget,
      toTarget: input.toTarget,
      sourceBuildId: from.build_id,
      sourceRunId: from.run_id,
      pageCount: from.page_count ?? 0,
      fileCount: from.file_count ?? 0,
      sourceBuildAt:
        from.started_at instanceof Date ? from.started_at.toISOString() : String(from.started_at),
    };
    const payloadHash = await hashProposalPayload(input);
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    let rows: { id: string }[];
    try {
      rows = (await tx.execute(sql`
        INSERT INTO deploy_pending_actions
          (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'promote',
          ${ctx.actorId}::uuid,
          ${JSON.stringify(input)}::jsonb,
          ${JSON.stringify(preview)}::jsonb,
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${payloadHash}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({
          kind: "HandlerError",
          operation: "deploy.propose_promote",
          message: DUPLICATE_PROPOSAL_MESSAGE,
        });
      }
      throw e;
    }
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.propose_promote",
        message: "insert returned no id",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "deploy.propose_promote",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `${input.fromTarget} → ${input.toTarget} (build=${from.build_id})`,
    });
    return ok({ proposalId, preview });
  },
});

const proposeRollbackInput = z
  .object({
    target: z.string().min(1).max(80),
    repoRoot: z.string().optional(),
  })
  .strict();

export const proposeDeployRollbackOp = defineOperation({
  name: "deploy.propose_rollback",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRollbackInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    // Preview: identify the prior succeeded build that rollback would restore.
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS run_id, r.build_id, r.started_at
      FROM deploy_runs r
      JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.name = ${input.target}
        AND r.status = 'succeeded'
        AND r.build_id IS NOT NULL
      ORDER BY r.started_at DESC
      LIMIT 2
    `)) as unknown as Array<{
      run_id: string;
      build_id: string | null;
      started_at: string | Date;
    }>;
    if (rows.length < 2) {
      return err({
        kind: "HandlerError",
        operation: "deploy.propose_rollback",
        message: `not enough successful builds on "${input.target}" to roll back`,
      });
    }
    const current = rows[0];
    const prior = rows[1];
    if (!current?.build_id || !prior?.build_id) {
      return err({
        kind: "HandlerError",
        operation: "deploy.propose_rollback",
        message: "succeeded builds missing build_id",
      });
    }
    const preview = {
      target: input.target,
      currentBuildId: current.build_id,
      restoreBuildId: prior.build_id,
      restoreRunId: prior.run_id,
    };
    const payloadHash = await hashProposalPayload(input);
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    let ins: { id: string }[];
    try {
      ins = (await tx.execute(sql`
        INSERT INTO deploy_pending_actions
          (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'rollback',
          ${ctx.actorId}::uuid,
          ${JSON.stringify(input)}::jsonb,
          ${JSON.stringify(preview)}::jsonb,
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${payloadHash}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({
          kind: "HandlerError",
          operation: "deploy.propose_rollback",
          message: DUPLICATE_PROPOSAL_MESSAGE,
        });
      }
      throw e;
    }
    const proposalId = ins[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.propose_rollback",
        message: "insert returned no id",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "deploy.propose_rollback",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `${input.target}: ${current.build_id} → ${prior.build_id}`,
    });
    return ok({ proposalId, preview });
  },
});

export const executeDeployProposalOp = defineOperation({
  name: "deploy.execute_proposal",
  // human-only by design: this is the "Go button" half. AI cannot
  // self-approve its own proposal.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ runId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, payload, status
      FROM deploy_pending_actions
      WHERE id = ${input.proposalId}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "promote" | "rollback";
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "deploy.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "deploy.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    // Dispatch the underlying op's handler directly with the same tx so
    // execute + status flip are atomic. The promoteDeploy / rollbackDeploy
    // handlers expect a system context (their actorScope is human+system);
    // ctx here is human (the Owner clicking Approve).
    const payload = parsePayload<Record<string, unknown>>(row.payload);
    let runId: string | null = null;
    if (row.kind === "promote") {
      const r = await promoteDeployOp.handler(
        ctx,
        payload as { fromTarget: string; toTarget: string; repoRoot?: string },
        tx,
      );
      if (!r.ok) {
        return err({
          kind: "HandlerError",
          operation: "deploy.execute_proposal",
          message: `underlying promote failed: ${r.error.kind in r.error && "message" in r.error ? (r.error as { message: string }).message : r.error.kind}`,
        });
      }
      runId = (r.value as { toRunId: string }).toRunId;
    } else if (row.kind === "rollback") {
      // Rollback's underlying op needs the explicit runId to restore.
      // The propose-time preview captured `restoreRunId`; pass it
      // along so the Owner's click reproduces what they previewed.
      const previewRows = (await tx.execute(sql`
        SELECT preview FROM deploy_pending_actions
        WHERE id = ${input.proposalId}::uuid
      `)) as unknown as Array<{ preview: { restoreRunId?: string } }>;
      const restoreRunId = previewRows[0]?.preview?.restoreRunId;
      if (!restoreRunId) {
        return err({
          kind: "HandlerError",
          operation: "deploy.execute_proposal",
          message: "rollback proposal preview missing restoreRunId",
        });
      }
      const r = await rollbackDeployOp.handler(
        ctx,
        {
          targetName: (payload as { target: string }).target,
          runId: restoreRunId,
          ...(payload as { repoRoot?: string }),
        },
        tx,
      );
      if (!r.ok) {
        return err({
          kind: "HandlerError",
          operation: "deploy.execute_proposal",
          message: `underlying rollback failed: ${r.error.kind in r.error && "message" in r.error ? (r.error as { message: string }).message : r.error.kind}`,
        });
      }
      runId = (r.value as { newRunId: string }).newRunId;
    }
    await tx.execute(sql`
      UPDATE deploy_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_run_id = ${runId === null ? null : sql`${runId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "deploy.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (runId=${runId ?? "(none)"})`,
    });
    return ok({ runId });
  },
});

export const rejectDeployProposalOp = defineOperation({
  name: "deploy.reject_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const r = await tx.execute(sql`
      UPDATE deploy_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    void r;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "deploy.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

export const listPendingDeployProposalsOp = defineOperation({
  name: "deploy.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 50;
    const rows = (await tx.execute(sql`
      SELECT
        id::text                       AS id,
        kind,
        proposed_by::text              AS proposed_by,
        payload,
        preview,
        status,
        created_at,
        decided_at,
        decided_by::text               AS decided_by,
        decision_reason,
        applied_run_id::text           AS applied_run_id
      FROM deploy_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as ProposalDbRow[];
    return ok({ proposals: rows.map(rowToOutput) });
  },
});

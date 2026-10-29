// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.19 — deploy.{propose_promote, propose_rollback, execute_proposal,
 * reject_proposal, list_pending}. First exemplar of CLAUDE.md §11.A's
 * propose/execute pattern for hard-to-revert ops.
 *
 *   AI says "publish staging to production"
 *   → AI tool → deploy.propose_promote (AI-callable)
 *     → row at status='pending' in deploy_pending_actions
 *     → AI replies "I prepared a proposal — click Approve at /settings/deployments/pending"
 *   Operator clicks Approve (in the chat, or /settings/deployments/pending)
 *   → deploy.execute_proposal (human-only, step-wise: #1225)
 *     → claims the row (deploy.begin_execute_proposal)
 *     → dispatches the underlying op (deploy.promote / .rollback) as its own op
 *     → marks row status='applied' (deploy.end_execute_proposal)
 *
 * The execute-side stays human-only so AI cannot self-approve. The
 * preview is computed at propose time so the operator's click decision
 * has full blast-radius context (build id, file count, etc.).
 */

import { randomUUID } from "node:crypto";
import {
  defineOperation,
  defineStepwiseOperation,
  execute,
  type OperationSteps,
  type QueryError,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  type ProposalStatus,
  proposalStatus,
  type Result,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { recordAuditFromCtx } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import { withAudit } from "./_audit.js";
import { mapRowToOutput, opError, toIso, toIsoRequired } from "./_helpers.js";
import {
  CLAIM_WITHOUT_RUN_MS,
  CLAIMED_PROPOSAL_MESSAGE,
  claimBlocksDecision,
} from "./_proposal-claim.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "./_propose-helpers.js";

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
  return mapRowToOutput(r, proposalRowSchema, (row) => ({
    id: row.id,
    kind: row.kind,
    proposedBy: row.proposed_by,
    payload: row.payload as Record<string, unknown>,
    preview: row.preview as Record<string, unknown>,
    status: row.status,
    createdAt: toIsoRequired(row.created_at, "deploy_pending_actions.created_at"),
    decidedAt: toIso(row.decided_at),
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    appliedRunId: row.applied_run_id,
  }));
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
  handler: withAudit(
    async (ctx, input, tx) => {
      if (input.fromTarget === input.toTarget) {
        return err(opError("deploy.propose_promote", "fromTarget and toTarget must differ"));
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
        return err(
          opError(
            "deploy.propose_promote",
            `no succeeded build to promote from "${input.fromTarget}". Run \`deploy.trigger\` for ${input.fromTarget} first.`,
          ),
        );
      }
      const preview = {
        fromTarget: input.fromTarget,
        toTarget: input.toTarget,
        sourceBuildId: from.build_id,
        sourceRunId: from.run_id,
        pageCount: from.page_count ?? 0,
        fileCount: from.file_count ?? 0,
        sourceBuildAt: toIsoRequired(from.started_at, "deploy_runs.started_at"),
      };
      const payloadHash = await hashProposalPayload(input);
      const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
      let rows: { id: string }[];
      try {
        rows = (await tx.execute(sql`
        INSERT INTO deploy_pending_actions
          (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'promote',
          ${ctx.actorId}::uuid,
          ${jsonbParam(input)},
          ${jsonbParam(preview)},
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${payloadHash}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      } catch (e) {
        if (isDuplicatePendingError(e)) {
          return err(opError("deploy.propose_promote", DUPLICATE_PROPOSAL_MESSAGE));
        }
        throw e;
      }
      const proposalId = rows[0]?.id;
      if (!proposalId) {
        return err(opError("deploy.propose_promote", "insert returned no id"));
      }
      return ok({ proposalId, preview });
    },
    {
      operation: "deploy.propose_promote",
      entityId: (_input, result) => (result.ok ? result.value.proposalId : null),
      resultSummary: (input, result) =>
        result.ok
          ? `${input.fromTarget} → ${input.toTarget} (build=${(result.value.preview.sourceBuildId as string | undefined) ?? "unknown"})`
          : null,
    },
  ),
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
  handler: withAudit(
    async (ctx, input, tx) => {
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
        return err(
          opError(
            "deploy.propose_rollback",
            `not enough successful builds on "${input.target}" to roll back`,
          ),
        );
      }
      const current = rows[0];
      const prior = rows[1];
      if (!current?.build_id || !prior?.build_id) {
        return err(opError("deploy.propose_rollback", "succeeded builds missing build_id"));
      }
      const preview = {
        target: input.target,
        currentBuildId: current.build_id,
        restoreBuildId: prior.build_id,
        restoreRunId: prior.run_id,
      };
      const payloadHash = await hashProposalPayload(input);
      const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
      let ins: { id: string }[];
      try {
        ins = (await tx.execute(sql`
        INSERT INTO deploy_pending_actions
          (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'rollback',
          ${ctx.actorId}::uuid,
          ${jsonbParam(input)},
          ${jsonbParam(preview)},
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${payloadHash}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      } catch (e) {
        if (isDuplicatePendingError(e)) {
          return err(opError("deploy.propose_rollback", DUPLICATE_PROPOSAL_MESSAGE));
        }
        throw e;
      }
      const proposalId = ins[0]?.id;
      if (!proposalId) {
        return err(opError("deploy.propose_rollback", "insert returned no id"));
      }
      return ok({ proposalId, preview });
    },
    {
      operation: "deploy.propose_rollback",
      entityId: (_input, result) => (result.ok ? result.value.proposalId : null),
      resultSummary: (input, result) =>
        result.ok
          ? `${input.target}: ${(result.value.preview.currentBuildId as string | undefined) ?? "unknown"} → ${(result.value.preview.restoreBuildId as string | undefined) ?? "unknown"}`
          : null,
    },
  ),
});

const beginExecuteOutput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("apply"),
    proposalKind: z.enum(["promote", "rollback"]),
    payload: z.record(z.string(), z.unknown()),
    /** A rollback's run to restore, captured at propose time. */
    restoreRunId: z.string().nullable(),
  }),
  /** An earlier click's Publish live or rollback succeeded but was never marked applied; now it is. */
  z.object({ kind: z.literal("applied"), runId: z.string() }),
]);

/**
 * #589 / review on #1251 — the claim and record steps are ops of their own,
 * so each one requires the same approver permission as
 * deploy.execute_proposal: calling a step directly authorises nothing more.
 */
export const beginExecuteDeployProposalOp = requiresApproverPermission(
  ["deploy.trigger"],
  defineOperation({
    name: "deploy.begin_execute_proposal",
    // Why human-only: the first step of deploy.execute_proposal (the Owner's
    // Approve click, §11.A), run as the approver; no AI tool wraps it.
    actorScope: ["human", "system"],
    database: "cms_admin",
    input: z.object({ proposalId: z.string().uuid(), runId: z.string().uuid() }).strict(),
    output: beginExecuteOutput,
    handler: async (ctx, input, tx) => {
      const rows = (await tx.execute(sql`
      SELECT p.kind, p.payload, p.preview, p.status,
             p.claimed_by_run_id::text AS claimed_by_run_id,
             (p.claimed_at IS NOT NULL
              AND p.claimed_at > clock_timestamp() - ${CLAIM_WITHOUT_RUN_MS}::int * interval '1 millisecond')
               AS claim_recent,
             r.status AS run_status,
             (r.lease_expires_at IS NOT NULL AND r.lease_expires_at > clock_timestamp()) AS run_live
      FROM deploy_pending_actions p
      LEFT JOIN deploy_runs r ON r.id = p.claimed_by_run_id
      WHERE p.id = ${input.proposalId}::uuid
      FOR UPDATE OF p
    `)) as unknown as Array<{
        kind: "promote" | "rollback";
        payload: unknown;
        preview: { restoreRunId?: string } | string | null;
        status: string;
        claimed_by_run_id: string | null;
        claim_recent: boolean;
        run_status: string | null;
        run_live: boolean | null;
      }>;
      const row = rows[0];
      if (!row) return err(opError("deploy.execute_proposal", "proposal not found"));
      if (row.status !== "pending") {
        return err(opError("deploy.execute_proposal", `proposal is already ${row.status}`));
      }
      // An earlier click's Publish live or rollback went live, but its
      // approval was never marked applied (the apply died between the two):
      // record it now instead of releasing a second time. A rollback's run
      // carries the claimed id and is committed with the rollback itself.
      if (row.claimed_by_run_id !== null && row.run_status === "succeeded") {
        await markApplied(tx, ctx, input.proposalId, row.claimed_by_run_id);
        return ok({ kind: "applied" as const, runId: row.claimed_by_run_id });
      }
      // A second click (another tab, a retried request) while the first one
      // still applies: the Publish live it started is running, or it is
      // between the claim and its run's start, or a rollback is waiting.
      const claimLive =
        row.run_status === "running"
          ? row.run_live === true
          : row.run_status === null && row.claim_recent;
      if (claimLive) {
        return err(
          opError(
            "deploy.execute_proposal",
            `this proposal is being applied right now${row.claimed_by_run_id ? ` (run ${row.claimed_by_run_id})` : ""} — wait for it to finish; Settings → Deployments shows it. Nothing else was started.`,
          ),
        );
      }
      const preview = parsePayload<{ restoreRunId?: string }>(row.preview ?? {});
      if (row.kind === "rollback" && !preview.restoreRunId) {
        return err(
          opError("deploy.execute_proposal", "rollback proposal preview missing restoreRunId"),
        );
      }
      await tx.execute(sql`
      UPDATE deploy_pending_actions
      SET claimed_by_run_id = ${input.runId}::uuid, claimed_at = clock_timestamp()
      WHERE id = ${input.proposalId}::uuid
    `);
      return ok({
        kind: "apply" as const,
        proposalKind: row.kind,
        payload: parsePayload<Record<string, unknown>>(row.payload),
        restoreRunId: row.kind === "rollback" ? (preview.restoreRunId ?? null) : null,
      });
    },
  }),
);

/** Mark the proposal applied by `runId` and record the approval (one transaction). */
async function markApplied(
  tx: Parameters<typeof recordAuditFromCtx>[0],
  ctx: Parameters<typeof recordAuditFromCtx>[1],
  proposalId: string,
  runId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE deploy_pending_actions
    SET status = 'applied',
        decided_at = now(),
        decided_by = ${ctx.actorId}::uuid,
        applied_run_id = ${runId === null ? null : sql`${runId}::uuid`}
    WHERE id = ${proposalId}::uuid AND status = 'pending'
  `);
  await recordAuditFromCtx(tx, ctx, {
    operation: "deploy.execute_proposal",
    input: { proposalId },
    succeeded: true,
    entityId: proposalId,
    resultSummary: `applied (runId=${runId ?? "(none)"})`,
  });
}

export const endExecuteDeployProposalOp = requiresApproverPermission(
  ["deploy.trigger"],
  defineOperation({
    name: "deploy.end_execute_proposal",
    // Why human-only: the last step of deploy.execute_proposal (the Owner's
    // Approve click, §11.A), run as the approver; no AI tool wraps it.
    actorScope: ["human", "system"],
    database: "cms_admin",
    input: z
      .object({
        proposalId: z.string().uuid(),
        outcome: z.discriminatedUnion("ok", [
          z.object({ ok: z.literal(true), runId: z.string().nullable() }),
          z.object({ ok: z.literal(false), message: z.string() }),
        ]),
      })
      .strict(),
    output: z.object({}),
    handler: async (ctx, input, tx) => {
      if (input.outcome.ok) {
        await markApplied(tx, ctx, input.proposalId, input.outcome.runId);
        return ok({});
      }
      // Nothing went live: release the claim so the card can be approved
      // again once the cause is fixed.
      await tx.execute(sql`
      UPDATE deploy_pending_actions SET claimed_by_run_id = NULL, claimed_at = NULL
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
      await recordAuditFromCtx(tx, ctx, {
        operation: "deploy.execute_proposal",
        input: { proposalId: input.proposalId },
        succeeded: false,
        entityId: input.proposalId,
        resultSummary: input.outcome.message,
      });
      return ok({});
    },
  }),
);

/**
 * Apply an approved deploy proposal (the body of deploy.execute_proposal).
 * #1225 — no transaction is held while Publish live (or a rollback that
 * waits for one) runs: the proposal is claimed in one short step, the
 * underlying op runs as its own step-wise op, and the outcome is recorded
 * in a last short step. The claim keeps a second click from publishing
 * twice.
 */
async function runExecuteDeployProposal(
  ctx: ExecutionContext,
  input: { proposalId: string },
  steps: OperationSteps,
): Promise<Result<{ runId: string | null }, QueryError>> {
  const { registry, adapter } = steps;
  // The run's id (Publish live or rollback), minted now so the claim names it.
  const claimedRunId = randomUUID();
  const begun = await execute(registry, adapter, ctx, "deploy.begin_execute_proposal", {
    proposalId: input.proposalId,
    runId: claimedRunId,
  });
  if (!begun.ok) return err(begun.error);
  const plan = begun.value as z.infer<typeof beginExecuteOutput>;
  if (plan.kind === "applied") return ok({ runId: plan.runId });

  // The underlying ops expect a human or system context (their actorScope
  // is human + system); ctx is the human who clicked Approve.
  let applied: Result<unknown, QueryError>;
  if (plan.proposalKind === "promote") {
    const payload = plan.payload as { fromTarget: string; toTarget: string; repoRoot?: string };
    applied = await execute(
      registry,
      adapter,
      ctx,
      "deploy.promote",
      {
        fromTarget: payload.fromTarget,
        toTarget: payload.toTarget,
        ...(payload.repoRoot ? { repoRoot: payload.repoRoot } : {}),
        runId: claimedRunId,
      },
      steps.signal ? { signal: steps.signal } : {},
    );
  } else {
    // The propose-time preview captured `restoreRunId`; the Owner's click
    // reproduces what they previewed.
    applied = await execute(registry, adapter, ctx, "deploy.rollback", {
      targetName: (plan.payload as { target: string }).target,
      runId: plan.restoreRunId,
      newRunId: claimedRunId,
      ...(typeof plan.payload.repoRoot === "string" ? { repoRoot: plan.payload.repoRoot } : {}),
    });
  }
  const runId = applied.ok
    ? plan.proposalKind === "promote"
      ? (applied.value as { toRunId: string }).toRunId
      : (applied.value as { newRunId: string }).newRunId
    : null;
  const message = applied.ok
    ? null
    : `underlying ${plan.proposalKind} failed: ${describeError(applied.error)}`;
  const ended = await execute(registry, adapter, ctx, "deploy.end_execute_proposal", {
    proposalId: input.proposalId,
    outcome: message === null ? { ok: true, runId } : { ok: false, message },
  });
  if (message !== null) return err(opError("deploy.execute_proposal", message));
  if (!ended.ok) {
    return err(
      opError(
        "deploy.execute_proposal",
        `the ${plan.proposalKind} was applied (run ${runId}), but marking the proposal applied failed: ${describeError(ended.error)}. Approving it again records it without publishing twice.`,
      ),
    );
  }
  return ok({ runId });
}

const executeDeployProposalOpDefinition = defineStepwiseOperation({
  name: "deploy.execute_proposal",
  // Why human-only: the Owner's Approve/Reject click of the §11.A gate — the AI proposes, it can
  // never approve or reject its own proposal.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ runId: z.string().nullable() }),
  stepwise: runExecuteDeployProposal,
});

/** #589 — the approver must hold deploy.trigger (see _approver-permission.ts). */
export const executeDeployProposalOp = requiresApproverPermission(
  ["deploy.trigger"],
  executeDeployProposalOpDefinition,
);

/** Whether the proposal is pending with a claim that blocks another decision. */
async function claimedPending(
  tx: Parameters<typeof recordAuditFromCtx>[0],
  proposalId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 AS blocked FROM deploy_pending_actions
    WHERE id = ${proposalId}::uuid AND status = 'pending' AND ${claimBlocksDecision()}
  `)) as unknown as { blocked: number }[];
  return rows.length > 0;
}

export const rejectDeployProposalOp = defineOperation({
  name: "deploy.reject_proposal",
  // Why human-only: the Owner's Approve/Reject click of the §11.A gate — the AI proposes, it can
  // never approve or reject its own proposal.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: withAudit(
    async (ctx, input, tx) => {
      const r = (await tx.execute(sql`
        UPDATE deploy_pending_actions
        SET status = 'rejected',
            decided_at = now(),
            decided_by = ${ctx.actorId}::uuid,
            decision_reason = ${input.reason ?? null}
        WHERE id = ${input.proposalId}::uuid AND status = 'pending'
          AND NOT ${claimBlocksDecision()}
        RETURNING id
      `)) as unknown as { id: string }[];
      if (r.length === 0 && (await claimedPending(tx, input.proposalId))) {
        return err(opError("deploy.reject_proposal", CLAIMED_PROPOSAL_MESSAGE));
      }
      return ok({});
    },
    {
      operation: "deploy.reject_proposal",
      entityId: (input) => input.proposalId,
      resultSummary: (input) => input.reason ?? "(no reason)",
    },
  ),
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

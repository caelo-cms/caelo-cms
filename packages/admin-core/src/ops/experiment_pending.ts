// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.24 — experiments.{propose_activate, propose_complete,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * Same shape as snapshot_pending (v0.2.23) and role_pending (v0.2.22).
 *
 * experiments.create is already AI-open; only the lifecycle transitions
 * that affect production traffic (activate flips assignment on; complete
 * stops new assignments + records the winner) go through the gate.
 *
 * Preview surfaces:
 * - propose_activate: experiment slug + page slug + variant labels +
 *   weights so the Owner can confirm the traffic split before live.
 * - propose_complete: current per-variant assignment + conversion
 *   counts so the Owner can sanity-check the AI-proposed winner.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { activateExperimentOp, completeExperimentOp } from "./experiments.js";

// ─── propose_activate ────────────────────────────────────────────────

const proposeActivateInput = z.object({ experimentId: z.string().uuid() }).strict();

export const proposeExperimentActivateOp = defineOperation({
  name: "experiments.propose_activate",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeActivateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const meta = await loadExperimentMeta(tx, input.experimentId);
    if (!meta) {
      return err({
        kind: "HandlerError",
        operation: "experiments.propose_activate",
        message: `experiment ${input.experimentId} not found`,
      });
    }
    if (meta.status !== "draft") {
      return err({
        kind: "HandlerError",
        operation: "experiments.propose_activate",
        message: `experiment is ${meta.status}; activate requires draft`,
      });
    }
    const preview = {
      experimentId: meta.id,
      experimentSlug: meta.slug,
      pageId: meta.page_id,
      pageSlug: meta.page_slug,
      pageTitle: meta.page_title,
      variants: meta.variants,
      currentStatus: meta.status,
    };
    return queueProposal(
      tx,
      ctx,
      "activate",
      input.experimentId,
      input,
      preview,
      "experiments.propose_activate",
    );
  },
});

// ─── propose_complete ────────────────────────────────────────────────

const proposeCompleteInput = z
  .object({
    experimentId: z.string().uuid(),
    winningVariant: z.string().min(1).max(120).optional(),
  })
  .strict();

export const proposeExperimentCompleteOp = defineOperation({
  name: "experiments.propose_complete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCompleteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const meta = await loadExperimentMeta(tx, input.experimentId);
    if (!meta) {
      return err({
        kind: "HandlerError",
        operation: "experiments.propose_complete",
        message: `experiment ${input.experimentId} not found`,
      });
    }
    if (meta.status !== "active") {
      return err({
        kind: "HandlerError",
        operation: "experiments.propose_complete",
        message: `experiment is ${meta.status}; complete requires active`,
      });
    }
    if (input.winningVariant !== undefined) {
      const labels = meta.variants.map((v) => v.label);
      if (!labels.includes(input.winningVariant)) {
        return err({
          kind: "HandlerError",
          operation: "experiments.propose_complete",
          message: `winningVariant "${input.winningVariant}" not in experiment variants ${labels.join(", ")}`,
        });
      }
    }
    const counts = await loadVariantAssignmentCounts(tx, input.experimentId);
    const preview = {
      experimentId: meta.id,
      experimentSlug: meta.slug,
      pageSlug: meta.page_slug,
      currentStatus: meta.status,
      proposedWinner: input.winningVariant ?? null,
      variantStats: meta.variants.map((v) => ({
        label: v.label,
        weight: v.weight,
        assignments: counts.get(v.label) ?? 0,
      })),
    };
    return queueProposal(
      tx,
      ctx,
      "complete",
      input.experimentId,
      input,
      preview,
      "experiments.propose_complete",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeExperimentProposalOp = defineOperation({
  name: "experiments.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ experimentId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, experiment_id::text AS experiment_id, payload, status
      FROM experiment_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "activate" | "complete";
      experiment_id: string;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "experiments.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "experiments.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as Record<string, unknown>;
    if (row.kind === "activate") {
      const r = await activateExperimentOp.handler(
        ctx,
        payload as Parameters<typeof activateExperimentOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "activate");
    } else if (row.kind === "complete") {
      const r = await completeExperimentOp.handler(
        ctx,
        payload as Parameters<typeof completeExperimentOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "complete");
    }
    await tx.execute(sql`
      UPDATE experiment_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "experiments.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (experimentId=${row.experiment_id})`,
    });
    return ok({ experimentId: row.experiment_id });
  },
});

export const rejectExperimentProposalOp = defineOperation({
  name: "experiments.reject_proposal",
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
    await tx.execute(sql`
      UPDATE experiment_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "experiments.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

const proposalRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["activate", "complete"]),
  proposedBy: z.string(),
  experimentId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingExperimentProposalsOp = defineOperation({
  name: "experiments.list_pending",
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
        id::text AS id, kind, proposed_by::text AS proposed_by,
        experiment_id::text AS experiment_id, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM experiment_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "activate" | "complete";
      proposed_by: string;
      experiment_id: string;
      payload: unknown;
      preview: unknown;
      status: "pending" | "applied" | "rejected" | "superseded";
      created_at: string | Date;
      decided_at: string | Date | null;
      decided_by: string | null;
      decision_reason: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        experimentId: r.experiment_id,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        decidedAt: r.decided_at
          ? r.decided_at instanceof Date
            ? r.decided_at.toISOString()
            : String(r.decided_at)
          : null,
        decidedBy: r.decided_by,
        decisionReason: r.decision_reason,
      })),
    });
  },
});

// ─── helpers ─────────────────────────────────────────────────────────

interface ExperimentMeta {
  id: string;
  slug: string;
  status: string;
  page_id: string;
  page_slug: string | null;
  page_title: string | null;
  variants: Array<{ label: string; weight: number }>;
}

async function loadExperimentMeta(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  experimentId: string,
): Promise<ExperimentMeta | null> {
  const rows = (await tx.execute(sql`
    SELECT
      e.id::text AS id, e.slug, e.status,
      e.page_id::text AS page_id, e.variants,
      p.slug AS page_slug, p.title AS page_title
    FROM experiments e
    LEFT JOIN pages p ON p.id = e.page_id
    WHERE e.id = ${experimentId}::uuid
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    slug: string;
    status: string;
    page_id: string;
    page_slug: string | null;
    page_title: string | null;
    variants: unknown;
  }>;
  const r = rows[0];
  if (!r) return null;
  const parsedVariants =
    typeof r.variants === "string" ? JSON.parse(r.variants) : (r.variants ?? []);
  return {
    id: r.id,
    slug: r.slug,
    status: r.status,
    page_id: r.page_id,
    page_slug: r.page_slug,
    page_title: r.page_title,
    variants: Array.isArray(parsedVariants) ? parsedVariants : [],
  };
}

async function loadVariantAssignmentCounts(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  experimentId: string,
): Promise<Map<string, number>> {
  const rows = (await tx.execute(sql`
    SELECT variant_label AS label, count(*)::int AS c
    FROM experiment_assignments
    WHERE experiment_id = ${experimentId}::uuid
    GROUP BY variant_label
  `)) as unknown as Array<{ label: string; c: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.label, r.c);
  return m;
}

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "activate" | "complete",
  experimentId: string,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload(payload);
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO experiment_pending_actions
        (kind, proposed_by, experiment_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${experimentId}::uuid,
        ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify(preview)}::jsonb,
        'pending',
        ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
        ${payloadHash}
      )
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
  return ok({ proposalId, preview: preview as Record<string, unknown> });
}

function passthroughError(
  error: unknown,
  kind: string,
): {
  ok: false;
  error: { kind: "HandlerError"; operation: string; message: string };
} {
  const msg =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "unknown";
  return err({
    kind: "HandlerError",
    operation: "experiments.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}

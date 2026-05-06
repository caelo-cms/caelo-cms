// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.27 — mcp_tokens.{propose_create, propose_revoke,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * Same shape as ai_providers_pending (v0.2.26). Token plaintext is
 * generated server-side at execute time (createMcpTokenOp's existing
 * crypto path) and returned ONCE in the form-action response banner.
 * No token material lands in the proposal payload, audit log, or
 * pending-list output.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { createMcpTokenOp, revokeMcpTokenOp } from "./security/mcp_tokens.js";

// ─── propose_create ──────────────────────────────────────────────────

const proposeCreateInput = z
  .object({
    displayName: z.string().min(1).max(100),
    aiCostCapMicrocents: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const proposeMcpTokenCreateOp = defineOperation({
  name: "mcp_tokens.propose_create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCreateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const preview = {
      kind: "create",
      displayName: input.displayName,
      aiCostCapMicrocents: input.aiCostCapMicrocents ?? null,
      // Always-true reminder for the Owner UI banner.
      tokenPolicy: "server-generated-on-approve",
    };
    return queueProposal(tx, ctx, "create", null, input, preview, "mcp_tokens.propose_create");
  },
});

// ─── propose_revoke ──────────────────────────────────────────────────

const proposeRevokeInput = z.object({ tokenId: z.string().uuid() }).strict();

export const proposeMcpTokenRevokeOp = defineOperation({
  name: "mcp_tokens.propose_revoke",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRevokeInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, display_name, last_used_at, revoked_at, expires_at
      FROM mcp_tokens WHERE id = ${input.tokenId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      display_name: string;
      last_used_at: Date | string | null;
      revoked_at: Date | string | null;
      expires_at: Date | string;
    }>;
    const t = rows[0];
    if (!t) {
      return err({
        kind: "HandlerError",
        operation: "mcp_tokens.propose_revoke",
        message: `token ${input.tokenId} not found`,
      });
    }
    if (t.revoked_at) {
      return err({
        kind: "HandlerError",
        operation: "mcp_tokens.propose_revoke",
        message: "token is already revoked",
      });
    }
    const toS = (v: Date | string | null): string | null =>
      v === null ? null : v instanceof Date ? v.toISOString() : String(v);
    const preview = {
      kind: "revoke",
      tokenId: t.id,
      displayName: t.display_name,
      lastUsedAt: toS(t.last_used_at),
      expiresAt: toS(t.expires_at),
    };
    // Pass the underlying op's expected key (`id`) in the payload so
    // execute_proposal forwards it without remapping.
    return queueProposal(
      tx,
      ctx,
      "revoke",
      input.tokenId,
      { id: input.tokenId },
      preview,
      "mcp_tokens.propose_revoke",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeMcpTokenProposalOp = defineOperation({
  name: "mcp_tokens.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    tokenId: z.string().nullable(),
    /** Plaintext bearer for `create` proposals; null for `revoke`. */
    plaintextToken: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, token_id::text AS token_id, payload, status
      FROM mcp_token_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "revoke";
      token_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "mcp_tokens.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "mcp_tokens.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    let resultTokenId: string | null = row.token_id;
    let plaintextToken: string | null = null;
    if (row.kind === "create") {
      const r = await createMcpTokenOp.handler(
        ctx,
        row.payload as Parameters<typeof createMcpTokenOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "create");
      const v = r.value as { id: string; plaintextToken: string };
      resultTokenId = v.id;
      plaintextToken = v.plaintextToken;
    } else if (row.kind === "revoke") {
      const r = await revokeMcpTokenOp.handler(
        ctx,
        row.payload as Parameters<typeof revokeMcpTokenOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "revoke");
    }
    await tx.execute(sql`
      UPDATE mcp_token_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_token_id = ${resultTokenId === null ? null : sql`${resultTokenId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "mcp_tokens.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      // Never log the plaintext token.
      resultSummary: `${row.kind} applied (tokenId=${resultTokenId ?? "(none)"})`,
    });
    return ok({ tokenId: resultTokenId, plaintextToken });
  },
});

export const rejectMcpTokenProposalOp = defineOperation({
  name: "mcp_tokens.reject_proposal",
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
      UPDATE mcp_token_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "mcp_tokens.reject_proposal",
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
  kind: z.enum(["create", "revoke"]),
  proposedBy: z.string(),
  tokenId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "applied", "rejected", "superseded"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingMcpTokenProposalsOp = defineOperation({
  name: "mcp_tokens.list_pending",
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
        token_id::text AS token_id, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM mcp_token_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "revoke";
      proposed_by: string;
      token_id: string | null;
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
        tokenId: r.token_id,
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

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string },
  kind: "create" | "revoke",
  tokenId: string | null,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const rows = (await tx.execute(sql`
    INSERT INTO mcp_token_pending_actions
      (kind, proposed_by, token_id, payload, preview, status)
    VALUES (
      ${kind},
      ${ctx.actorId}::uuid,
      ${tokenId === null ? null : sql`${tokenId}::uuid`},
      ${JSON.stringify(payload)}::jsonb,
      ${JSON.stringify(preview)}::jsonb,
      'pending'
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
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
    operation: "mcp_tokens.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}

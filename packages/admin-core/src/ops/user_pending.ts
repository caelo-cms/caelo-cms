// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.21 — users.{propose_create, propose_set_roles, propose_delete,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * Same shape as deploy_pending (v0.2.19) + layout_pending (v0.2.20).
 *
 * Security note — AI never handles credentials. propose_create takes
 * email + displayName + roleNames only (no password). execute_proposal
 * generates a secure random temporary password server-side, calls the
 * existing users.create op with it, and returns the password ONCE in
 * the result so the Owner can share it with the new user. Subsequent
 * reads of the proposal row never see the password — it's not stored.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { createUserOp, deleteUserOp, setUserRolesOp } from "./users.js";

// ─── propose_create ──────────────────────────────────────────────────

const proposeCreateInput = z
  .object({
    email: z.string().email().max(254),
    displayName: z.string().min(1).max(128),
    roleNames: z.array(z.string()).default([]),
  })
  .strict();

export const proposeUserCreateOp = defineOperation({
  name: "users.propose_create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCreateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    // Pre-flight: email must be unique among non-deleted users.
    const dup = (await tx.execute(sql`
      SELECT 1 AS exists FROM users WHERE email = ${input.email} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "users.propose_create",
        message: `email "${input.email}" already in use`,
      });
    }
    const preview = {
      email: input.email,
      displayName: input.displayName,
      roleNames: input.roleNames,
      passwordPolicy: "server-generated-on-approve",
    };
    return queueProposal(tx, ctx, "create", null, input, preview, "users.propose_create");
  },
});

// ─── propose_set_roles ───────────────────────────────────────────────

const proposeSetRolesInput = z
  .object({
    userId: z.string().uuid(),
    roleNames: z.array(z.string()),
  })
  .strict();

export const proposeUserSetRolesOp = defineOperation({
  name: "users.propose_set_roles",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSetRolesInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const userRows = (await tx.execute(sql`
      SELECT u.id::text AS id, u.email,
        COALESCE(
          (SELECT array_agg(r.name) FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = u.id),
          ARRAY[]::text[]
        ) AS current_roles
      FROM users u
      WHERE u.id = ${input.userId}::uuid AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as Array<{ id: string; email: string; current_roles: string[] }>;
    const u = userRows[0];
    if (!u) {
      return err({
        kind: "HandlerError",
        operation: "users.propose_set_roles",
        message: `user ${input.userId} not found or deleted`,
      });
    }
    const preview = {
      userId: u.id,
      email: u.email,
      currentRoles: u.current_roles,
      newRoles: input.roleNames,
    };
    return queueProposal(
      tx,
      ctx,
      "set_roles",
      input.userId,
      input,
      preview,
      "users.propose_set_roles",
    );
  },
});

// ─── propose_delete ──────────────────────────────────────────────────

const proposeDeleteInput = z.object({ userId: z.string().uuid() }).strict();

export const proposeUserDeleteOp = defineOperation({
  name: "users.propose_delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeDeleteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const userRows = (await tx.execute(sql`
      SELECT u.id::text AS id, u.email, u.is_first_owner,
        COALESCE(
          (SELECT array_agg(r.name) FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = u.id),
          ARRAY[]::text[]
        ) AS current_roles
      FROM users u
      WHERE u.id = ${input.userId}::uuid AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      email: string;
      is_first_owner: boolean;
      current_roles: string[];
    }>;
    const u = userRows[0];
    if (!u) {
      return err({
        kind: "HandlerError",
        operation: "users.propose_delete",
        message: `user ${input.userId} not found or already deleted`,
      });
    }
    if (u.is_first_owner) {
      return err({
        kind: "HandlerError",
        operation: "users.propose_delete",
        message: "cannot delete the first Owner — promote another user to Owner first",
      });
    }
    const preview = {
      userId: u.id,
      email: u.email,
      currentRoles: u.current_roles,
    };
    return queueProposal(tx, ctx, "delete", input.userId, input, preview, "users.propose_delete");
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeUserProposalOp = defineOperation({
  name: "users.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    userId: z.string().nullable(),
    /** Set ONCE on a successful create-proposal apply. The Owner UI
     *  surfaces this in a one-time copy-to-clipboard banner; it's
     *  never persisted past the response. */
    temporaryPassword: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, user_id::text AS user_id, payload, status
      FROM user_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "set_roles" | "delete";
      user_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "users.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "users.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = row.payload as Record<string, unknown>;
    let resultUserId: string | null = row.user_id;
    let temporaryPassword: string | null = null;
    if (row.kind === "create") {
      // Server-generated one-time password — never travels through AI.
      // 16 bytes of crypto random → base64url ≈ 22 chars; safe for
      // copy/paste, will be rotated on first login (operator's responsibility).
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      temporaryPassword = Buffer.from(bytes).toString("base64url");
      const r = await createUserOp.handler(
        ctx,
        {
          ...(payload as { email: string; displayName: string; roleNames: string[] }),
          password: temporaryPassword,
        },
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "create");
      resultUserId = (r.value as { userId: string }).userId;
    } else if (row.kind === "set_roles") {
      const r = await setUserRolesOp.handler(
        ctx,
        payload as Parameters<typeof setUserRolesOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "set_roles");
    } else if (row.kind === "delete") {
      const r = await deleteUserOp.handler(
        ctx,
        payload as Parameters<typeof deleteUserOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "delete");
    }
    await tx.execute(sql`
      UPDATE user_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_user_id = ${resultUserId === null ? null : sql`${resultUserId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      // Never log the temp password.
      resultSummary: `${row.kind} applied (userId=${resultUserId ?? "(none)"})`,
    });
    return ok({ userId: resultUserId, temporaryPassword });
  },
});

export const rejectUserProposalOp = defineOperation({
  name: "users.reject_proposal",
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
      UPDATE user_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.reject_proposal",
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
  kind: z.enum(["create", "set_roles", "delete"]),
  proposedBy: z.string(),
  userId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "applied", "rejected", "superseded"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingUserProposalsOp = defineOperation({
  name: "users.list_pending",
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
        user_id::text AS user_id, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM user_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "set_roles" | "delete";
      proposed_by: string;
      user_id: string | null;
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
        userId: r.user_id,
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
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "create" | "set_roles" | "delete",
  userId: string | null,
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
      INSERT INTO user_pending_actions
        (kind, proposed_by, user_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${userId === null ? null : sql`${userId}::uuid`},
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
    operation: "users.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}

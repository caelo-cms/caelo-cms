// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.22 — roles.{propose_create, propose_update_permissions,
 * propose_delete, execute_proposal, reject_proposal, list_pending}.
 *
 * Same shape as user_pending (v0.2.21) and layout_pending (v0.2.20).
 *
 * Built-in roles (owner / editor / reviewer) are protected at the
 * underlying op layer — propose_delete on a builtin still queues, but
 * the execute path will fail with the same builtin-protected error so
 * the rejection is visible in the audit log.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { PERMISSIONS, type Permission } from "../permissions.js";
import { createRoleOp, deleteRoleOp, updateRolePermissionsOp } from "./roles.js";

const PermissionEnum = z.enum(
  PERMISSIONS as readonly Permission[] as [Permission, ...Permission[]],
);

// ─── propose_create ──────────────────────────────────────────────────

const proposeCreateInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, "lowercase, digits, _ or -"),
    description: z.string().max(500).default(""),
    permissions: z.array(PermissionEnum).default([]),
  })
  .strict();

export const proposeRoleCreateOp = defineOperation({
  name: "roles.propose_create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCreateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    if (input.name === "owner" || input.name === "editor" || input.name === "reviewer") {
      return err({
        kind: "HandlerError",
        operation: "roles.propose_create",
        message: "cannot reuse a built-in role name",
      });
    }
    const dup = (await tx.execute(sql`
      SELECT 1 AS exists FROM roles WHERE name = ${input.name} LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "roles.propose_create",
        message: `role "${input.name}" already exists`,
      });
    }
    const preview = {
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      permissionCount: input.permissions.length,
    };
    return queueProposal(tx, ctx, "create", null, input, preview, "roles.propose_create");
  },
});

// ─── propose_update_permissions ──────────────────────────────────────

const proposeUpdateInput = z
  .object({
    roleId: z.string().uuid(),
    permissions: z.array(PermissionEnum),
  })
  .strict();

export const proposeRoleUpdatePermissionsOp = defineOperation({
  name: "roles.propose_update_permissions",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeUpdateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id, r.name, r.is_builtin,
        COALESCE(
          (SELECT array_agg(p.name) FROM role_permissions rp
            JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = r.id),
          ARRAY[]::text[]
        ) AS current_permissions,
        (SELECT count(*) FROM user_roles WHERE role_id = r.id) AS user_count
      FROM roles r
      WHERE r.id = ${input.roleId}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      name: string;
      is_builtin: boolean;
      current_permissions: string[];
      user_count: number | string;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "roles.propose_update_permissions",
        message: `role ${input.roleId} not found`,
      });
    }
    const added = input.permissions.filter((p) => !r.current_permissions.includes(p));
    const removed = r.current_permissions.filter(
      (p) => !input.permissions.includes(p as Permission),
    );
    const preview = {
      roleId: r.id,
      roleName: r.name,
      isBuiltin: r.is_builtin,
      currentPermissions: r.current_permissions,
      newPermissions: input.permissions,
      added,
      removed,
      affectedUserCount: Number(r.user_count),
    };
    return queueProposal(
      tx,
      ctx,
      "update_permissions",
      input.roleId,
      input,
      preview,
      "roles.propose_update_permissions",
    );
  },
});

// ─── propose_delete ──────────────────────────────────────────────────

const proposeDeleteInput = z.object({ roleId: z.string().uuid() }).strict();

export const proposeRoleDeleteOp = defineOperation({
  name: "roles.propose_delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeDeleteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id, r.name, r.is_builtin,
        (SELECT count(*) FROM user_roles WHERE role_id = r.id) AS user_count
      FROM roles r
      WHERE r.id = ${input.roleId}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      name: string;
      is_builtin: boolean;
      user_count: number | string;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "roles.propose_delete",
        message: `role ${input.roleId} not found`,
      });
    }
    if (r.is_builtin) {
      return err({
        kind: "HandlerError",
        operation: "roles.propose_delete",
        message: "cannot delete a built-in role",
      });
    }
    const preview = {
      roleId: r.id,
      roleName: r.name,
      affectedUserCount: Number(r.user_count),
    };
    return queueProposal(tx, ctx, "delete", input.roleId, input, preview, "roles.propose_delete");
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeRoleProposalOp = defineOperation({
  name: "roles.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ roleId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, role_id::text AS role_id, payload, status
      FROM role_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "update_permissions" | "delete";
      role_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "roles.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "roles.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = row.payload as Record<string, unknown>;
    let resultRoleId: string | null = row.role_id;
    if (row.kind === "create") {
      const r = await createRoleOp.handler(
        ctx,
        payload as Parameters<typeof createRoleOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "create");
      resultRoleId = (r.value as { roleId: string }).roleId;
    } else if (row.kind === "update_permissions") {
      const r = await updateRolePermissionsOp.handler(
        ctx,
        payload as Parameters<typeof updateRolePermissionsOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "update_permissions");
    } else if (row.kind === "delete") {
      const r = await deleteRoleOp.handler(
        ctx,
        payload as Parameters<typeof deleteRoleOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "delete");
    }
    await tx.execute(sql`
      UPDATE role_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_role_id = ${resultRoleId === null ? null : sql`${resultRoleId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "roles.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (roleId=${resultRoleId ?? "(none)"})`,
    });
    return ok({ roleId: resultRoleId });
  },
});

export const rejectRoleProposalOp = defineOperation({
  name: "roles.reject_proposal",
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
      UPDATE role_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "roles.reject_proposal",
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
  kind: z.enum(["create", "update_permissions", "delete"]),
  proposedBy: z.string(),
  roleId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "applied", "rejected", "superseded"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingRoleProposalsOp = defineOperation({
  name: "roles.list_pending",
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
        role_id::text AS role_id, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM role_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "update_permissions" | "delete";
      proposed_by: string;
      role_id: string | null;
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
        roleId: r.role_id,
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
  kind: "create" | "update_permissions" | "delete",
  roleId: string | null,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const rows = (await tx.execute(sql`
    INSERT INTO role_pending_actions (kind, proposed_by, role_id, payload, preview, status)
    VALUES (
      ${kind},
      ${ctx.actorId}::uuid,
      ${roleId === null ? null : sql`${roleId}::uuid`},
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
    operation: "roles.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}

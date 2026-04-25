// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";
import { hashPassword } from "../password.js";

export const createFirstOwnerOp = defineOperation({
  name: "users.create_first_owner",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(256),
    displayName: z.string().min(1).max(128),
  }),
  output: z.object({ userId: z.string() }),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(736578)`);

    const existing = (await tx.execute(
      sql`SELECT 1 AS exists FROM users WHERE deleted_at IS NULL LIMIT 1`,
    )) as unknown as { exists: number }[];
    if (existing.length > 0) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        operation: "users.create_first_owner",
        input,
        succeeded: false,
        resultSummary: "setup-already-complete",
      });
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: "setup already complete",
      });
    }

    const passwordHash = await hashPassword(input.password);
    const actorRows = (await tx.execute(sql`
      INSERT INTO actors (kind, display_name)
      VALUES ('human', ${input.displayName})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const actorId = actorRows[0]?.id;
    if (!actorId) {
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: "actor insert returned no row",
      });
    }
    await tx.execute(sql`
      INSERT INTO users (id, email, password_hash, is_first_owner)
      VALUES (${actorId}::uuid, ${input.email}, ${passwordHash}, true)
    `);
    await tx.execute(sql`
      INSERT INTO user_roles (user_id, role_id)
      SELECT ${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
    `);

    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      operation: "users.create_first_owner",
      input,
      succeeded: true,
      entityId: actorId,
      resultSummary: `email=${input.email}`,
    });
    return ok({ userId: actorId });
  },
});

export const isSetupCompleteOp = defineOperation({
  name: "users.is_setup_complete",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ complete: z.boolean() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT EXISTS(SELECT 1 FROM users WHERE deleted_at IS NULL) AS complete`,
    )) as unknown as { complete: boolean }[];
    return ok({ complete: rows[0]?.complete ?? false });
  },
});

export const listUsersOp = defineOperation({
  name: "users.list",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({
    users: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        displayName: z.string(),
        isFirstOwner: z.boolean(),
        createdAt: z.string(),
        deletedAt: z.string().nullable(),
        roles: z.array(z.string()),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.includeDeleted
        ? sql`
            SELECT u.id::text AS id, u.email AS email, a.display_name AS "displayName",
                   u.is_first_owner AS "isFirstOwner", u.created_at AS "createdAt",
                   u.deleted_at AS "deletedAt"
            FROM users u JOIN actors a ON a.id = u.id
            ORDER BY u.created_at ASC
          `
        : sql`
            SELECT u.id::text AS id, u.email AS email, a.display_name AS "displayName",
                   u.is_first_owner AS "isFirstOwner", u.created_at AS "createdAt",
                   u.deleted_at AS "deletedAt"
            FROM users u JOIN actors a ON a.id = u.id
            WHERE u.deleted_at IS NULL
            ORDER BY u.created_at ASC
          `,
    )) as unknown as {
      id: string;
      email: string;
      displayName: string;
      isFirstOwner: boolean;
      createdAt: string | Date;
      deletedAt: string | Date | null;
    }[];

    const roleRows = (await tx.execute(sql`
      SELECT ur.user_id::text AS user_id, r.name AS role
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    `)) as unknown as { user_id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of roleRows) {
      const arr = roles.get(r.user_id) ?? [];
      arr.push(r.role);
      roles.set(r.user_id, arr);
    }

    return ok({
      users: rows.map((u) => ({
        ...u,
        createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt),
        deletedAt:
          u.deletedAt === null
            ? null
            : u.deletedAt instanceof Date
              ? u.deletedAt.toISOString()
              : String(u.deletedAt),
        roles: roles.get(u.id) ?? [],
      })),
    });
  },
});

export const createUserOp = defineOperation({
  name: "users.create",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(256),
    displayName: z.string().min(1).max(128),
    roleNames: z.array(z.string()).default([]),
  }),
  output: z.object({ userId: z.string() }),
  handler: async (ctx, input, tx) => {
    const dup = (await tx.execute(
      sql`SELECT 1 AS exists FROM users WHERE email = ${input.email} AND deleted_at IS NULL LIMIT 1`,
    )) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "users.create",
        input,
        succeeded: false,
        resultSummary: "email-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "users.create",
        message: "email already exists",
      });
    }

    const passwordHash = await hashPassword(input.password);
    const actorRows = (await tx.execute(sql`
      INSERT INTO actors (kind, display_name)
      VALUES ('human', ${input.displayName})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const userId = actorRows[0]?.id;
    if (!userId) {
      return err({ kind: "HandlerError", operation: "users.create", message: "no id returned" });
    }
    await tx.execute(sql`
      INSERT INTO users (id, email, password_hash, is_first_owner)
      VALUES (${userId}::uuid, ${input.email}, ${passwordHash}, false)
    `);
    for (const roleName of input.roleNames) {
      await tx.execute(sql`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${userId}::uuid, r.id FROM roles r WHERE r.name = ${roleName}
        ON CONFLICT DO NOTHING
      `);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "users.create",
      input,
      succeeded: true,
      entityId: userId,
      resultSummary: `roles=${input.roleNames.join(",") || "(none)"}`,
    });
    return ok({ userId });
  },
});

export const setUserRolesOp = defineOperation({
  name: "users.set_roles",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    userId: z.string(),
    roleNames: z.array(z.string()),
  }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${input.userId}::uuid`);
    for (const roleName of input.roleNames) {
      await tx.execute(sql`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${input.userId}::uuid, r.id FROM roles r WHERE r.name = ${roleName}
        ON CONFLICT DO NOTHING
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "users.set_roles",
      input,
      succeeded: true,
      entityId: input.userId,
      resultSummary: `roles=${input.roleNames.join(",") || "(none)"}`,
    });
    return ok({});
  },
});

/**
 * Soft-delete: sets `deleted_at = now()`. Audit history stays linked because
 * the actor row + audit_events rows are untouched. A future `users.restore`
 * op can revive a soft-deleted account by clearing the flag.
 */
export const deleteUserOp = defineOperation({
  name: "users.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ userId: z.string() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT is_first_owner, deleted_at FROM users WHERE id = ${input.userId}::uuid
    `)) as unknown as { is_first_owner: boolean; deleted_at: Date | null }[];
    const target = rows[0];
    if (!target) {
      return err({ kind: "HandlerError", operation: "users.delete", message: "user not found" });
    }
    if (target.is_first_owner) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "users.delete",
        input,
        succeeded: false,
        entityId: input.userId,
        resultSummary: "first-owner-protected",
      });
      return err({
        kind: "HandlerError",
        operation: "users.delete",
        message: "cannot delete the first owner",
      });
    }
    if (target.deleted_at !== null) {
      // Already soft-deleted; idempotent — succeed without touching the row.
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "users.delete",
        input,
        succeeded: true,
        entityId: input.userId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    await tx.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${input.userId}::uuid`);
    // Revoke active sessions so a soft-deleted user is signed out immediately.
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${input.userId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "users.delete",
      input,
      succeeded: true,
      entityId: input.userId,
      resultSummary: "soft-deleted",
    });
    return ok({});
  },
});

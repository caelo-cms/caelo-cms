// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { PERMISSIONS, type Permission } from "../permissions.js";

const PermissionEnum = z.enum(
  PERMISSIONS as readonly Permission[] as [Permission, ...Permission[]],
);

export const listRolesOp = defineOperation({
  name: "roles.list",
  // CLAUDE.md §11: read surface open to AI ("explain what each role
  // can do"). Writes stay human-only — security domain.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({
    roles: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        isBuiltin: z.boolean(),
        permissions: z.array(z.string()),
      }),
    ),
  }),
  handler: async (_ctx, _input, tx) => {
    const rolesRows = (await tx.execute(sql`
      SELECT id::text AS id, name, description, is_builtin AS "isBuiltin"
      FROM roles ORDER BY is_builtin DESC, name ASC
    `)) as unknown as { id: string; name: string; description: string; isBuiltin: boolean }[];
    const grantRows = (await tx.execute(sql`
      SELECT rp.role_id::text AS role_id, p.name AS permission
      FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    `)) as unknown as { role_id: string; permission: string }[];
    const grants = new Map<string, string[]>();
    for (const g of grantRows) {
      const arr = grants.get(g.role_id) ?? [];
      arr.push(g.permission);
      grants.set(g.role_id, arr);
    }
    return ok({
      roles: rolesRows.map((r) => ({ ...r, permissions: grants.get(r.id) ?? [] })),
    });
  },
});

export const createRoleOp = defineOperation({
  name: "roles.create",
  // Why human-only: Owner-only — security; defining new permission sets.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, "lowercase, digits, _ or -"),
    description: z.string().max(500).default(""),
    permissions: z.array(PermissionEnum).default([]),
  }),
  output: z.object({ roleId: z.string() }),
  handler: async (ctx, input, tx) => {
    if (input.name === "owner" || input.name === "editor" || input.name === "reviewer") {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "roles.create",
        input,
        succeeded: false,
        resultSummary: "builtin-name-rejected",
      });
      return err({
        kind: "HandlerError",
        operation: "roles.create",
        message: "cannot reuse a built-in role name",
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO roles (name, description, is_builtin)
      VALUES (${input.name}, ${input.description}, false)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const roleId = rows[0]?.id;
    if (!roleId) {
      return err({ kind: "HandlerError", operation: "roles.create", message: "no id returned" });
    }
    if (input.permissions.length > 0) {
      for (const perm of input.permissions) {
        await tx.execute(sql`
          INSERT INTO role_permissions (role_id, permission_id)
          SELECT ${roleId}::uuid, p.id FROM permissions p WHERE p.name = ${perm}
        `);
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "roles.create",
      input,
      succeeded: true,
      entityId: roleId,
      resultSummary: `name=${input.name},perms=${input.permissions.length}`,
    });
    return ok({ roleId });
  },
});

export const deleteRoleOp = defineOperation({
  name: "roles.delete",
  // Why human-only: Owner-only — security.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ roleId: z.string() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT is_builtin FROM roles WHERE id = ${input.roleId}::uuid
    `)) as unknown as { is_builtin: boolean }[];
    const target = rows[0];
    if (!target) {
      return err({ kind: "HandlerError", operation: "roles.delete", message: "role not found" });
    }
    if (target.is_builtin) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "roles.delete",
        input,
        succeeded: false,
        entityId: input.roleId,
        resultSummary: "builtin-protected",
      });
      return err({
        kind: "HandlerError",
        operation: "roles.delete",
        message: "cannot delete a built-in role",
      });
    }
    await tx.execute(sql`DELETE FROM roles WHERE id = ${input.roleId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "roles.delete",
      input,
      succeeded: true,
      entityId: input.roleId,
    });
    return ok({});
  },
});

export const updateRolePermissionsOp = defineOperation({
  name: "roles.update_permissions",
  // Why human-only: Owner-only — security.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    roleId: z.string(),
    permissions: z.array(PermissionEnum),
  }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM role_permissions WHERE role_id = ${input.roleId}::uuid`);
    for (const perm of input.permissions) {
      await tx.execute(sql`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT ${input.roleId}::uuid, p.id FROM permissions p WHERE p.name = ${perm}
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "roles.update_permissions",
      input,
      succeeded: true,
      entityId: input.roleId,
      resultSummary: `perms=${input.permissions.length}`,
    });
    return ok({});
  },
});

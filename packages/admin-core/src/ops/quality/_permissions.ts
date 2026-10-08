// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — permission checks INSIDE the quality ops whose callers are
 * not all form actions: an in-chat approval card applies its op as the
 * chat's operator with no route-level `requirePermission` in front, so the
 * op itself must refuse an operator who may not make the decision
 * (accepting needs content.write, publishing needs deploy.trigger).
 */

import type { defineOperation } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { Permission } from "../../permissions.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Whether `ctx`'s actor holds `permission` through a role. System actors
 *  (workers, migrations, tests driving ops directly) always may. */
export async function actorHasPermission(
  tx: Tx,
  ctx: ExecutionContext,
  permission: Permission,
): Promise<boolean> {
  if (ctx.actorKind === "system") return true;
  const rows = (await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ${ctx.actorId}::uuid AND p.name = ${permission}
    ) AS allowed
  `)) as unknown as { allowed: boolean }[];
  return rows[0]?.allowed === true;
}

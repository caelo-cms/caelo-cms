// SPDX-License-Identifier: MPL-2.0

import { approverPermissionsOf, type Permission } from "@caelo-cms/admin-core";
import type { OperationRegistry } from "@caelo-cms/query-api";
import { error, redirect } from "@sveltejs/kit";

/**
 * Route guards. `+page.server.ts` / `+server.ts` files call these at the top
 * of their `load` / request handlers. Permission checks use the fixed
 * permission catalog (never role names) so custom roles integrate uniformly.
 */

export function requireUser(locals: App.Locals): NonNullable<App.Locals["user"]> {
  if (!locals.user) throw redirect(303, "/login");
  return locals.user;
}

export function requirePermission(
  locals: App.Locals,
  permission: Permission,
): NonNullable<App.Locals["user"]> {
  const user = requireUser(locals);
  if (!user.permissions.has(permission)) {
    throw error(403, `Missing required permission: ${permission}`);
  }
  return user;
}

/**
 * #589 — guard a pending-queue Approve action with exactly the permission(s)
 * its executor op declares (`requiresApproverPermission` in admin-core), so
 * the page and the in-chat approval can never disagree. Fails closed: an
 * executor that declares nothing cannot be approved from a page either.
 *
 * @param executeOp the op the Approve action is about to run.
 */
export function requireApproverPermission(
  locals: App.Locals,
  registry: OperationRegistry,
  executeOp: string,
): NonNullable<App.Locals["user"]> {
  const user = requireUser(locals);
  const op = registry.lookup(executeOp);
  const required = op.ok ? approverPermissionsOf(op.value) : null;
  if (!required) {
    throw error(500, `${executeOp} declares no approver permission; refusing to approve.`);
  }
  for (const permission of required) {
    if (!user.permissions.has(permission)) {
      throw error(403, `Missing required permission: ${permission}`);
    }
  }
  return user;
}

export const SESSION_COOKIE = "caelo_session";
export const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  // `secure` only in production; dev serves over http.
  secure: process.env.NODE_ENV === "production",
};

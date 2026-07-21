// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { opErrorMessage } from "$lib/server/op-error.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "users.manage");
  const { adapter, registry } = getQueryContext();

  const [usersResult, rolesResult] = await Promise.all([
    execute(registry, adapter, locals.ctx, "users.list", {}),
    execute(registry, adapter, locals.ctx, "roles.list", {}),
  ]);

  const users = usersResult.ok
    ? (
        usersResult.value as {
          users: {
            id: string;
            email: string;
            displayName: string;
            isFirstOwner: boolean;
            roles: string[];
          }[];
        }
      ).users
    : [];

  const roles = rolesResult.ok
    ? (rolesResult.value as { roles: { name: string }[] }).roles.map((r) => r.name)
    : [];

  return { users, roles };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("displayName") ?? "").trim();
    const roleNames = form.getAll("roleNames").map(String).filter(Boolean);

    const result = await execute(registry, adapter, locals.ctx, "users.create", {
      email,
      password,
      displayName,
      roleNames,
    });
    if (!result.ok) return fail(400, { error: "Could not create user." });
    return { ok: true };
  },

  setRoles: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const roleNames = form.getAll("roleNames").map(String).filter(Boolean);

    const result = await execute(registry, adapter, locals.ctx, "users.set_roles", {
      userId,
      roleNames,
    });
    if (!result.ok) return fail(400, { error: "Could not update roles." });
    return { ok: true };
  },

  delete: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "users.delete", { userId });
    if (!result.ok) return fail(400, { error: "Could not delete user." });
    return { ok: true };
  },

  resetPassword: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");

    // Elevate to a system kind so the cross-user write clears the self-or-system
    // RLS on `users`/`sessions` (a bare human owner is blocked); keep the owner
    // id for audit attribution. `users.manage` was checked above.
    const result = await execute(
      registry,
      adapter,
      { ...locals.ctx, actorKind: "system" },
      "users.admin_set_password",
      { userId, newPassword },
    );
    if (!result.ok) {
      return fail(400, { error: opErrorMessage(result.error, "Could not reset the password.") });
    }
    return { ok: true, resetUserId: userId };
  },
};

// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
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
};

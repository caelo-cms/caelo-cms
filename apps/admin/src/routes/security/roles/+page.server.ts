// SPDX-License-Identifier: MPL-2.0

import { PERMISSIONS } from "@caelo/admin-core";
import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { adapter, registry } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "roles.manage");

  const list = await execute(registry, adapter, locals.ctx, "roles.list", {});
  const roles =
    list.ok && list.value
      ? (
          list.value as {
            roles: {
              id: string;
              name: string;
              description: string;
              isBuiltin: boolean;
              permissions: string[];
            }[];
          }
        ).roles
      : [];

  return {
    roles,
    allPermissions: [...PERMISSIONS],
  };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const permissions = form.getAll("permissions").map(String);

    const result = await execute(registry, adapter, locals.ctx, "roles.create", {
      name,
      description,
      permissions,
    });
    if (!result.ok) return fail(400, { error: "Could not create role." });
    return { ok: true };
  },

  delete: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    const roleId = String(form.get("roleId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "roles.delete", { roleId });
    if (!result.ok) return fail(400, { error: "Could not delete role." });
    return { ok: true };
  },
};

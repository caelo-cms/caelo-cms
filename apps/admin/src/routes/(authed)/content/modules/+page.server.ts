// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "modules.list", {});
  const modules = result.ok
    ? (
        result.value as {
          modules: { id: string; slug: string; displayName: string; updatedAt: string }[];
        }
      ).modules
    : [];
  return { modules };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const slug = String(form.get("slug") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const html = String(form.get("html") ?? "");

    const result = await execute(registry, adapter, locals.ctx, "modules.create", {
      slug,
      displayName,
      html,
    });
    if (!result.ok) return fail(400, { error: "Could not create module." });
    const moduleId = (result.value as { moduleId: string }).moduleId;
    throw redirect(303, `/content/modules/${moduleId}`);
  },
};

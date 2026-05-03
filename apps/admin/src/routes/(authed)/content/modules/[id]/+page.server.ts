// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "modules.get", {
    moduleId: params.id,
  });
  if (!result.ok) throw error(404, "Module not found");
  return { module: (result.value as { module: unknown }).module };
};

export const actions: Actions = {
  update: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const result = await execute(registry, adapter, locals.ctx, "modules.update", {
      moduleId: params.id,
      displayName: String(form.get("displayName") ?? ""),
      html: String(form.get("html") ?? ""),
      css: String(form.get("css") ?? ""),
      js: String(form.get("js") ?? ""),
    });
    if (!result.ok) return fail(400, { error: "Could not update module." });
    return { ok: true };
  },

  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const result = await execute(registry, adapter, locals.ctx, "modules.delete", {
      moduleId: params.id,
    });
    if (!result.ok) return fail(400, { error: "Could not delete module." });
    throw redirect(303, "/content/modules");
  },
};

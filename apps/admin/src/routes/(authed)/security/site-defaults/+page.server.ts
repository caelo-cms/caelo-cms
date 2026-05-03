// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const [defaultsRes, layoutsRes, tplsRes] = await Promise.all([
    execute(registry, adapter, locals.ctx, "site_defaults.get", {}),
    execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
    execute(registry, adapter, locals.ctx, "templates.list", { includeDeleted: false }),
  ]);
  const defaults = defaultsRes.ok
    ? (
        defaultsRes.value as {
          defaults: {
            defaultLayoutId: string;
            defaultLayoutSlug: string;
            defaultTemplateId: string;
            defaultTemplateSlug: string;
          } | null;
        }
      ).defaults
    : null;
  const layouts = layoutsRes.ok
    ? (layoutsRes.value as { layouts: { id: string; slug: string; displayName: string }[] }).layouts
    : [];
  const templates = tplsRes.ok
    ? (
        tplsRes.value as {
          templates: { id: string; slug: string; displayName: string; layoutId: string }[];
        }
      ).templates
    : [];
  return { defaults, layouts, templates };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const defaultLayoutId = String(form.get("defaultLayoutId") ?? "");
    const defaultTemplateId = String(form.get("defaultTemplateId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "site_defaults.set", {
      defaultLayoutId,
      defaultTemplateId,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not save defaults.";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Saved." };
  },
};

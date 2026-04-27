// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface LayoutRow {
  id: string;
  slug: string;
  displayName: string;
  blocks: { name: string; displayName: string; position: number }[];
}

interface TemplateRow {
  id: string;
  slug: string;
  layoutId: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  // Owner-gating until the catalogue grows explicit `layouts.write` /
  // `site_defaults.write` permissions; `roles.manage` is the closest
  // existing Owner-only permission.
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();

  const [layoutsRes, tplsRes] = await Promise.all([
    execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
    execute(registry, adapter, locals.ctx, "templates.list", { includeDeleted: false }),
  ]);
  const layouts = layoutsRes.ok ? (layoutsRes.value as { layouts: LayoutRow[] }).layouts : [];
  const templates = tplsRes.ok ? (tplsRes.value as { templates: TemplateRow[] }).templates : [];
  const templatesByLayout = new Map<string, string[]>();
  for (const t of templates) {
    const arr = templatesByLayout.get(t.layoutId) ?? [];
    arr.push(t.slug);
    templatesByLayout.set(t.layoutId, arr);
  }
  return {
    layouts: layouts.map((l) => ({ ...l, templates: templatesByLayout.get(l.id) ?? [] })),
  };
};

export const actions: Actions = {
  delete: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const layoutId = String(form.get("layoutId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "layouts.delete", { layoutId });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not delete layout.";
      return fail(400, { error: message });
    }
    return { ok: true };
  },
};

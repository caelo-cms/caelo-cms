// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const guidesR = await execute(registry, adapter, locals.ctx, "style_guide.list", {});
  const localesR = await execute(registry, adapter, locals.ctx, "locales.list", {});
  const guides = guidesR.ok
    ? (guidesR.value as { guides: { locale: string; body: string; updatedAt: string }[] }).guides
    : [];
  const locales = localesR.ok
    ? (localesR.value as { locales: { code: string; displayName: string }[] }).locales
    : [];
  return { guides, locales };
};

export const actions: Actions = {
  upsert: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const locale = String(form.get("locale") ?? "").trim();
    const body = String(form.get("body") ?? "").trim();
    if (!locale || !body) return fail(400, { error: "locale and body required" });
    if (body.length > 4000) return fail(400, { error: "body must be ≤ 4000 chars" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "style_guide.set", { locale, body });
    if (!r.ok) return fail(400, { error: "save failed" });
    return { ok: true, message: `Style guide for ${locale} saved.` };
  },
  delete: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const locale = String(form.get("locale") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "style_guide.delete", { locale });
    if (!r.ok) return fail(400, { error: "delete failed" });
    return { ok: true, message: `Style guide for ${locale} removed.` };
  },
};

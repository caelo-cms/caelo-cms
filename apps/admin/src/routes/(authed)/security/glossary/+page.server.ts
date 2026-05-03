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
  const entriesR = await execute(registry, adapter, locals.ctx, "glossary.list", {});
  const localesR = await execute(registry, adapter, locals.ctx, "locales.list", {});
  const entries = entriesR.ok
    ? (
        entriesR.value as {
          entries: {
            id: string;
            sourceTerm: string;
            locale: string;
            translation: string;
            context: string | null;
          }[];
        }
      ).entries
    : [];
  const locales = localesR.ok
    ? (localesR.value as { locales: { code: string; displayName: string }[] }).locales
    : [];
  return { entries, locales };
};

export const actions: Actions = {
  upsert: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const sourceTerm = String(form.get("sourceTerm") ?? "").trim();
    const locale = String(form.get("locale") ?? "").trim();
    const translation = String(form.get("translation") ?? "").trim();
    const contextRaw = form.get("context");
    const context = contextRaw === null || contextRaw === "" ? null : String(contextRaw);
    if (!sourceTerm || !locale || !translation) {
      return fail(400, { error: "sourceTerm, locale, and translation are required" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "glossary.set", {
      sourceTerm,
      locale,
      translation,
      context,
    });
    if (!r.ok) return fail(400, { error: "save failed" });
    return { ok: true, message: "Glossary entry saved." };
  },
  delete: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "glossary.delete", { id });
    if (!r.ok) return fail(400, { error: "delete failed" });
    return { ok: true, message: "Entry removed." };
  },
};

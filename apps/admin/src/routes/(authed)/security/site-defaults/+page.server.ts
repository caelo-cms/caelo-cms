// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Stringify a Query API error into one human-readable line. Inlined
 * (rather than importing from admin-core's AI-tools helper) to keep
 * the dep direction admin → admin-core narrow + avoid pulling
 * AI-tool internals into a /security route.
 */
function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown error";
  const e = error as { kind?: string; message?: string; issues?: unknown[]; detail?: string };
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return `validation: ${e.issues
      .slice(0, 3)
      .map((i) => {
        const z = i as { path?: unknown[]; message?: string };
        return `${(z.path ?? []).join(".")}: ${z.message ?? "?"}`;
      })
      .join("; ")}`;
  }
  if (typeof e.message === "string") return e.message;
  if (typeof e.detail === "string") return e.detail;
  return e.kind ?? "unknown error";
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const [defaultsRes, layoutsRes, tplsRes] = await Promise.all([
    execute(registry, adapter, locals.ctx, "site_defaults.get", {}),
    execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
    execute(registry, adapter, locals.ctx, "templates.list", { includeDeleted: false }),
  ]);
  // Surface op failures so the operator sees WHY a select is empty
  // instead of "no dropdown" (which the prior silent `[]` produced).
  // Three independent ops; collect each error so the cause is
  // unambiguous when more than one fails.
  type Defaults = {
    defaultLayoutId: string;
    defaultLayoutSlug: string;
    defaultTemplateId: string;
    defaultTemplateSlug: string;
  } | null;
  type Layout = { id: string; slug: string; displayName: string };
  type Template = { id: string; slug: string; displayName: string; layoutId: string };
  const loadErrors: string[] = [];
  let defaults: Defaults = null;
  if (defaultsRes.ok) {
    defaults = (defaultsRes.value as { defaults: Defaults }).defaults;
  } else {
    loadErrors.push(`site_defaults.get failed: ${describeError(defaultsRes.error)}`);
  }
  let layouts: Layout[] = [];
  if (layoutsRes.ok) {
    layouts = (layoutsRes.value as { layouts: Layout[] }).layouts;
  } else {
    loadErrors.push(`layouts.list failed: ${describeError(layoutsRes.error)}`);
  }
  let templates: Template[] = [];
  if (tplsRes.ok) {
    templates = (tplsRes.value as { templates: Template[] }).templates;
  } else {
    loadErrors.push(`templates.list failed: ${describeError(tplsRes.error)}`);
  }
  return { defaults, layouts, templates, loadErrors };
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

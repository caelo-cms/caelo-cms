// SPDX-License-Identifier: MPL-2.0

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  // #1276 — the default layout is the only default: pages name their page
  // type, templates theirs.
  const [defaultsRes, layoutsRes] = await Promise.all([
    execute(registry, adapter, locals.ctx, "site_defaults.get", {}),
    execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
  ]);
  // Surface op failures so the operator sees WHY a select is empty
  // instead of "no dropdown" (which the prior silent `[]` produced).
  // Independent ops; collect each error so the cause is unambiguous
  // when more than one fails.
  type Defaults = {
    defaultLayoutId: string;
    defaultLayoutSlug: string;
  } | null;
  type Layout = { id: string; slug: string; displayName: string };
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
  return { defaults, layouts, loadErrors };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const defaultLayoutId = String(form.get("defaultLayoutId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "site_defaults.set", {
      defaultLayoutId,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not save defaults.";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Saved." };
  },
};

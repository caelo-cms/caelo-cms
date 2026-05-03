// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { structuredSetKind } from "@caelo-cms/shared";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, locals }) => {
  requirePermission(locals, "roles.manage");
  if (!structuredSetKind.safeParse(params.kind).success) {
    error(404, "Unknown structured-set kind");
  }
  return {};
};

export const actions: Actions = {
  default: async ({ params, request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const slug = String(form.get("slug") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const itemsRaw = String(form.get("items") ?? "[]");
    let items: unknown;
    try {
      items = JSON.parse(itemsRaw);
    } catch (e) {
      return fail(400, {
        error: `items must be valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
      });
    }
    if (!Array.isArray(items)) {
      return fail(400, { error: "items must be a JSON array" });
    }
    const result = await execute(registry, adapter, locals.ctx, "structured_sets.set", {
      kind: params.kind,
      slug,
      displayName,
      items,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not create set.";
      return fail(400, { error: message });
    }
    redirect(303, "/security/structured");
  },
};

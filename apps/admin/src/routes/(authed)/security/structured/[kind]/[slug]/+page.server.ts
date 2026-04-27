// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { structuredSetKind } from "@caelo/shared";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface SetRow {
  id: string;
  kind: string;
  slug: string;
  displayName: string;
  items: unknown;
  updatedAt: string;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "roles.manage");
  if (!structuredSetKind.safeParse(params.kind).success) {
    error(404, "Unknown structured-set kind");
  }
  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "structured_sets.get", {
    kind: params.kind,
    slug: params.slug,
  });
  if (!res.ok) error(404, "Set not found");
  const set = (res.value as { set: SetRow | null }).set;
  if (!set) error(404, "Set not found");
  return { set };
};

export const actions: Actions = {
  default: async ({ params, request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const displayName = String(form.get("displayName") ?? "").trim();
    const itemsRaw = String(form.get("items") ?? "");
    // Pass user input back on every failure path so the textarea
    // preserves their broken edit instead of resetting to the original
    // DB value — typing a fix requires keeping what they had.
    const values = { items: itemsRaw, displayName };
    let items: unknown;
    try {
      items = JSON.parse(itemsRaw);
    } catch (e) {
      return fail(400, {
        error: `items must be valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
        values,
      });
    }
    if (!Array.isArray(items)) {
      return fail(400, { error: "items must be a JSON array", values });
    }
    const result = await execute(registry, adapter, locals.ctx, "structured_sets.set", {
      kind: params.kind,
      slug: params.slug,
      displayName,
      items,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not save set.";
      return fail(400, { error: message, values });
    }
    // Stay on the same page — matches the /security/layouts edit
    // pattern and lets the user verify their change without an extra
    // click back through the index.
    return { ok: true, message: "Saved." };
  },
};

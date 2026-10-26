// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the Structure tab: edit the type of this list. The change
 * applies to every list of the type (the page says how many share it);
 * writing needs `content.structure`, without it the tab is read-only.
 */

import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { loadList, loadTypeEditorContext, saveListType } from "#lib/server/lists.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  return loadTypeEditorContext(locals.ctx);
};

export const actions: Actions = {
  saveType: async ({ params, request, locals }) => {
    requirePermission(locals, "content.structure");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const list = await loadList(locals.ctx, { slug: params.slug });
    if (!list) return fail(404, { error: `The list "${params.slug}" no longer exists.` });
    return saveListType(locals.ctx, list.type, form);
  },
};

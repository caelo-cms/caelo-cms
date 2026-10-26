// SPDX-License-Identifier: MPL-2.0

/** Epic #1107 — one list type under Types: edit it, or delete it while no list uses it. */

import { error, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import {
  loadListType,
  loadTypeEditorContext,
  runWrite,
  saveListType,
  writeFailure,
} from "#lib/server/lists.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const user = requirePermission(locals, "content.read");
  const type = await loadListType(locals.ctx, params.slug);
  if (!type) throw error(404, `No list type "${params.slug}".`);
  return {
    ...type,
    ...(await loadTypeEditorContext(locals.ctx)),
    canStructure: user.permissions.has("content.structure"),
  };
};

export const actions: Actions = {
  saveType: async ({ params, request, locals }) => {
    requirePermission(locals, "content.structure");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    return saveListType(locals.ctx, params.slug, form);
  },
  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.structure");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    // Refused while lists use the type; the message names them.
    const r = await runWrite(locals.ctx, "list_types.delete_many", { slugs: [params.slug] });
    if (!r.ok) return writeFailure(r.message);
    throw redirect(303, "/content/lists/types");
  },
};

// SPDX-License-Identifier: MPL-2.0

/** Epic #1107 — one page type under Types: edit it, or delete it while no page uses it. */

import type { PageTypeDef } from "@caelo-cms/shared";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import {
  jsonField,
  loadPageType,
  loadTemplatePicks,
  loadTypeEditorContext,
  runWrite,
  versionField,
  writeFailure,
} from "#lib/server/lists.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const user = requirePermission(locals, "content.read");
  const found = await loadPageType(locals.ctx, params.slug);
  if (!found) throw error(404, `No page type "${params.slug}".`);
  const {
    id: _id,
    version,
    updatedAt: _u,
    pageCount,
    vocabularySlugs: _v,
    ...definition
  } = found.pageType;
  const [editor, templates] = await Promise.all([
    loadTypeEditorContext(locals.ctx),
    loadTemplatePicks(locals.ctx),
  ]);
  return {
    definition: definition as PageTypeDef,
    version,
    pageCount,
    samplePages: found.samplePages,
    templates,
    ...editor,
    canStructure: user.permissions.has("content.structure"),
  };
};

export const actions: Actions = {
  save: async ({ params, request, locals }) => {
    requirePermission(locals, "content.structure");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const definition = jsonField<PageTypeDef>(form, "definition");
    if (!definition)
      return fail(400, { error: "The page type could not be read — reload and retry." });
    const expectedVersion = versionField(form);
    const r = await runWrite(locals.ctx, "page_types.upsert_many", {
      pageTypes: [
        {
          ...definition,
          slug: params.slug,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        },
      ],
      dropValues: form.get("dropValues") === "true",
    });
    if (!r.ok) return writeFailure(r.message);
    return { ok: "Page type saved." };
  },
  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.structure");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const r = await runWrite(locals.ctx, "page_types.delete_many", { slugs: [params.slug] });
    if (!r.ok) return writeFailure(r.message);
    throw redirect(303, "/content/lists/types");
  },
};

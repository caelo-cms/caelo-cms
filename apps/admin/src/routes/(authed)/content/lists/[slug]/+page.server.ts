// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the entries editor of one shared list. The whole tree is
 * saved in one `lists.upsert_many` call (entry ids kept, so translations,
 * terms and diffs stay attached), which validates it against the type,
 * snapshots it and makes it undoable like any other draft change.
 */

import type { ListItemInput } from "@caelo-cms/shared";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import {
  jsonField,
  loadList,
  loadModulePicks,
  loadPagePicks,
  loadPageTypes,
  loadVocabularies,
  runWrite,
  versionField,
  writeFailure,
} from "#lib/server/lists.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** What a query entry returns (docs/lists.md §12); `previewAvailable` stays false on a registry without it. */
const PREVIEW_OP = "lists.preview_source";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const { registry } = getQueryContext();
  const [pages, modules, vocabularies, pageTypes] = await Promise.all([
    loadPagePicks(locals.ctx),
    loadModulePicks(locals.ctx),
    loadVocabularies(locals.ctx),
    loadPageTypes(locals.ctx),
  ]);
  return {
    pages,
    modules,
    vocabularies,
    pageTypes: pageTypes.map((t) => ({ slug: t.slug, name: t.name, properties: t.properties })),
    previewAvailable: registry.lookup(PREVIEW_OP).ok,
  };
};

export const actions: Actions = {
  save: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const items = jsonField<ListItemInput[]>(form, "items");
    const name = String(form.get("name") ?? "").trim();
    const purpose = String(form.get("purpose") ?? "").trim();
    if (!items || !name || !purpose) {
      return fail(400, { error: "The list needs a name, a purpose and its entries." });
    }
    const list = await loadList(locals.ctx, { slug: params.slug });
    if (!list) return fail(404, { error: `The list "${params.slug}" no longer exists.` });
    const expectedVersion = versionField(form);
    const r = await runWrite(locals.ctx, "lists.upsert_many", {
      lists: [
        {
          slug: params.slug,
          name,
          purpose,
          type: list.type,
          items,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        },
      ],
    });
    if (!r.ok) return writeFailure(r.message);
    return { ok: "List saved." };
  },

  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    // Refused while a module still renders the list; the message names it.
    const r = await runWrite(locals.ctx, "lists.delete_many", { slugs: [params.slug] });
    if (!r.ok) return writeFailure(r.message);
    throw redirect(303, "/content/lists");
  },

  /** An embedded-module field: create the module's content for the entry. */
  createInstance: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const moduleId = String(form.get("moduleId") ?? "");
    const r = await runWrite(locals.ctx, "content_instances.create", { moduleId, values: {} });
    if (!r.ok) return writeFailure(r.message);
    return { contentInstanceId: (r.value as { contentInstanceId: string }).contentInstanceId };
  },

  /** What a query node returns with the entry's knobs (`lists.preview_source`). */
  previewSource: async ({ params, request, locals }) => {
    requirePermission(locals, "content.read");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { registry } = getQueryContext();
    if (!registry.lookup(PREVIEW_OP).ok) {
      return { previewUnavailable: "The query preview is not available in this version." };
    }
    const node = String(form.get("node") ?? "");
    const query = jsonField<Record<string, unknown>>(form, "query") ?? {};
    // A node kind of this list's type with the knobs being edited (docs/lists.md §12).
    const r = await runWrite(locals.ctx, PREVIEW_OP, { list: params.slug, node, value: query });
    if (!r.ok) return { previewUnavailable: r.message };
    return { preview: r.value };
  },
};

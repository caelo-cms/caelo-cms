// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — *Content → Menus & lists*: every shared list grouped by its
 * type, with purpose, entry count and where it is used, and a form to
 * create one. Menus, footer links, categories and tags are all lists of a
 * fitting type (docs/lists.md §1).
 */

import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { loadList, loadLists, loadListTypes, runWrite, writeFailure } from "#lib/server/lists.js";
import type { Actions, PageServerLoad } from "./$types";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const [lists, listTypes] = await Promise.all([loadLists(locals.ctx), loadListTypes(locals.ctx)]);
  return { lists, listTypes };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const name = String(form.get("name") ?? "").trim();
    const slug = String(form.get("slug") ?? "").trim();
    const purpose = String(form.get("purpose") ?? "").trim();
    const type = String(form.get("type") ?? "");
    if (!name || !purpose || !type) {
      return fail(400, { error: "Give the list a name, say what it is for, and pick its type." });
    }
    if (!SLUG_RE.test(slug)) {
      return fail(400, {
        error: "The list's address name may use lowercase letters, digits and hyphens only.",
      });
    }
    // lists.upsert_many replaces an existing list — creating must never do that.
    if (await loadList(locals.ctx, { slug })) {
      return fail(400, { error: `A list named "${slug}" already exists — pick another name.` });
    }
    const r = await runWrite(locals.ctx, "lists.upsert_many", {
      lists: [{ slug, name, purpose, type, items: [] }],
    });
    if (!r.ok) return writeFailure(r.message);
    throw redirect(303, `/content/lists/${encodeURIComponent(slug)}`);
  },
};

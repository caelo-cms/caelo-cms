// SPDX-License-Identifier: MPL-2.0
import { fail, redirect } from "@sveltejs/kit";
import { snakeName } from "#lib/lists/type-editor.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { loadListTypes, loadPageTypes, loadTemplatePicks, runWrite, writeFailure, } from "#lib/server/lists.js";
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const load = async ({ locals }) => {
    const user = requirePermission(locals, "content.read");
    const [listTypes, pageTypes, templates] = await Promise.all([
        loadListTypes(locals.ctx),
        loadPageTypes(locals.ctx),
        loadTemplatePicks(locals.ctx),
    ]);
    return {
        listTypes,
        pageTypes,
        templates,
        canStructure: user.permissions.has("content.structure"),
    };
};
function basics(form) {
    const name = String(form.get("name") ?? "").trim();
    const slug = String(form.get("slug") ?? "").trim();
    const purpose = String(form.get("purpose") ?? "").trim();
    if (!name || !purpose)
        return "Give the type a name and say what it is for.";
    if (!SLUG_RE.test(slug))
        return "The address name may use lowercase letters, digits and hyphens only.";
    return { name, slug, purpose };
}
export const actions = {
    createListType: async ({ request, locals }) => {
        requirePermission(locals, "content.structure");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const b = basics(form);
        if (typeof b === "string")
            return fail(400, { error: b });
        const types = await loadListTypes(locals.ctx);
        if (types.some((t) => t.slug === b.slug)) {
            return fail(400, { error: `A list type named "${b.slug}" already exists.` });
        }
        const role = String(form.get("role") ?? "content");
        const kind = snakeName(String(form.get("entryLabel") ?? "") || "entry", "entry");
        // A vocabulary entry needs a name and a slug (docs/lists.md §3).
        const fields = role === "vocabulary"
            ? [
                { name: "name", label: "Name", type: "text", required: true },
                { name: "slug", label: "Slug", type: "text", required: true },
            ]
            : [{ name: "label", label: "Label", type: "text", required: true }];
        const definition = {
            ...b,
            role,
            root: { allow: [kind] },
            nodes: { [kind]: { label: String(form.get("entryLabel") ?? "") || "Entry", fields } },
        };
        const r = await runWrite(locals.ctx, "list_types.upsert_many", { listTypes: [definition] });
        if (!r.ok)
            return writeFailure(r.message);
        throw redirect(303, `/content/lists/types/list/${b.slug}`);
    },
    createPageType: async ({ request, locals }) => {
        requirePermission(locals, "content.structure");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const b = basics(form);
        if (typeof b === "string")
            return fail(400, { error: b });
        const templateId = String(form.get("templateId") ?? "");
        if (!templateId)
            return fail(400, { error: "Pick the template pages of this type use." });
        const types = await loadPageTypes(locals.ctx);
        if (types.some((t) => t.slug === b.slug)) {
            return fail(400, { error: `A page type named "${b.slug}" already exists.` });
        }
        const collection = String(form.get("collection") ?? "");
        if (collection !== "true" && collection !== "false") {
            return fail(400, {
                error: "Say whether these are many similar pages listed together, or standalone pages.",
            });
        }
        const definition = {
            ...b,
            collection: collection === "true",
            templates: [templateId],
            defaultTemplate: templateId,
            properties: [],
            vocabularies: [],
        };
        // #1276 — the duplicate guard refuses a type that reads like an
        // existing one unless the person names it as deliberately different.
        const distinctFrom = String(form.get("distinctFrom") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        const r = await runWrite(locals.ctx, "page_types.upsert_many", {
            pageTypes: [{ ...definition, ...(distinctFrom.length > 0 ? { distinctFrom } : {}) }],
        });
        if (!r.ok)
            return writeFailure(r.message);
        throw redirect(303, `/content/lists/types/page/${b.slug}`);
    },
};

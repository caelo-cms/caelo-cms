// SPDX-License-Identifier: MPL-2.0
/**
 * Epic #1107 part G — the Languages tab of one list (shown while the
 * `international-site` plugin is active, `#lib/lists/editor-tabs.ts`):
 * per entry and language whether it is translated, stale, missing,
 * hidden there, or hidden because its link has no version in that
 * language. Data and the hide/show write come from the plugin's own
 * operations (`list_translation_status`, `set_list_item_visibility`);
 * translating is the AI's job (translate_chrome), so the tab links the
 * operator to the chat instead of offering a translation form.
 */
import { runPluginOperation } from "@caelo-cms/plugin-host";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { loadList } from "#lib/server/lists.js";
const PLUGIN = "international-site";
export const load = async ({ params, locals }) => {
    requirePermission(locals, "content.read");
    const list = await loadList(locals.ctx, { slug: params.slug });
    if (!list)
        throw error(404, `No list "${params.slug}".`);
    const r = await runPluginOperation({
        invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
        pluginSlug: PLUGIN,
        operationName: "list_translation_status",
        args: { listId: list.id },
    });
    if (!r.ok) {
        // Loud: the plugin is active (the tab is shown) but its call failed.
        throw error(502, `The language status of this list is unavailable: ${r.error.message}`);
    }
    return { languages: r.value };
};
export const actions = {
    visibility: async ({ request, locals }) => {
        requirePermission(locals, "content.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const address = form.get("address");
        const localeCode = form.get("localeCode");
        const hidden = form.get("hidden");
        if (typeof address !== "string" ||
            typeof localeCode !== "string" ||
            typeof hidden !== "string") {
            return fail(400, { error: "address, localeCode and hidden are required" });
        }
        const r = await runPluginOperation({
            invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
            pluginSlug: PLUGIN,
            operationName: "set_list_item_visibility",
            args: { items: [{ address, localeCode, hidden: hidden === "true" }] },
        });
        if (!r.ok)
            return fail(400, { error: r.error.message });
        return { ok: true, message: hidden === "true" ? "Hidden in that language." : "Shown again." };
    },
};

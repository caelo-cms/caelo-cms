// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    // Owner-gating until the catalogue grows explicit `layouts.write` /
    // `site_defaults.write` permissions; `roles.manage` is the closest
    // existing Owner-only permission.
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const [layoutsRes, tplsRes] = await Promise.all([
        execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
        execute(registry, adapter, locals.ctx, "templates.list", { includeDeleted: false }),
    ]);
    const layouts = layoutsRes.ok ? layoutsRes.value.layouts : [];
    const templates = tplsRes.ok ? tplsRes.value.templates : [];
    const templatesByLayout = new Map();
    for (const t of templates) {
        const arr = templatesByLayout.get(t.layoutId) ?? [];
        arr.push(t.slug);
        templatesByLayout.set(t.layoutId, arr);
    }
    return {
        layouts: layouts.map((l) => ({ ...l, templates: templatesByLayout.get(l.id) ?? [] })),
    };
};
export const actions = {
    delete: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const layoutId = String(form.get("layoutId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "layouts.delete", { layoutId });
        if (!result.ok) {
            const message = result.error.message ?? "Could not delete layout.";
            return fail(400, { error: message });
        }
        return { ok: true };
    },
};

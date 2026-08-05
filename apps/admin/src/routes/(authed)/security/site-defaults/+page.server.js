// SPDX-License-Identifier: MPL-2.0
import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const [defaultsRes, layoutsRes, tplsRes] = await Promise.all([
        execute(registry, adapter, locals.ctx, "site_defaults.get", {}),
        execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
        execute(registry, adapter, locals.ctx, "templates.list", { includeDeleted: false }),
    ]);
    const loadErrors = [];
    let defaults = null;
    if (defaultsRes.ok) {
        defaults = defaultsRes.value.defaults;
    }
    else {
        loadErrors.push(`site_defaults.get failed: ${describeError(defaultsRes.error)}`);
    }
    let layouts = [];
    if (layoutsRes.ok) {
        layouts = layoutsRes.value.layouts;
    }
    else {
        loadErrors.push(`layouts.list failed: ${describeError(layoutsRes.error)}`);
    }
    let templates = [];
    if (tplsRes.ok) {
        templates = tplsRes.value.templates;
    }
    else {
        loadErrors.push(`templates.list failed: ${describeError(tplsRes.error)}`);
    }
    return { defaults, layouts, templates, loadErrors };
};
export const actions = {
    default: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const defaultLayoutId = String(form.get("defaultLayoutId") ?? "");
        const defaultTemplateId = String(form.get("defaultTemplateId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "site_defaults.set", {
            defaultLayoutId,
            defaultTemplateId,
        });
        if (!result.ok) {
            const message = result.error.message ?? "Could not save defaults.";
            return fail(400, { error: message });
        }
        return { ok: true, message: "Saved." };
    },
};

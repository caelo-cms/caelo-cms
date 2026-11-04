// SPDX-License-Identifier: MPL-2.0
import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    // #1276 — the default layout is the only default: pages name their page
    // type, templates theirs.
    const [defaultsRes, layoutsRes] = await Promise.all([
        execute(registry, adapter, locals.ctx, "site_defaults.get", {}),
        execute(registry, adapter, locals.ctx, "layouts.list", { includeDeleted: false }),
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
    return { defaults, layouts, loadErrors };
};
export const actions = {
    default: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const defaultLayoutId = String(form.get("defaultLayoutId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "site_defaults.set", {
            defaultLayoutId,
        });
        if (!result.ok) {
            const message = result.error.message ?? "Could not save defaults.";
            return fail(400, { error: message });
        }
        return { ok: true, message: "Saved." };
    },
};

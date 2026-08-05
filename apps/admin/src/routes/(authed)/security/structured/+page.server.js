// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    // Owner-gated until the catalogue grows explicit
    // structured_sets.write permissions; roles.manage is the closest
    // existing Owner-only permission (matches /security/layouts).
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const res = await execute(registry, adapter, locals.ctx, "structured_sets.list", {});
    const sets = res.ok ? res.value.sets : [];
    return { sets };
};
export const actions = {
    delete: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const setId = String(form.get("setId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "structured_sets.delete", {
            setId,
        });
        if (!result.ok) {
            const message = result.error.message ?? "Could not delete set.";
            return fail(400, { error: message });
        }
        return { ok: true };
    },
};

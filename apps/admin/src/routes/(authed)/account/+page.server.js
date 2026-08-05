// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { SESSION_COOKIE } from "$lib/server/guards.js";
import { opErrorMessage } from "$lib/server/op-error.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = ({ locals }) => {
    return { email: locals.user?.email ?? "" };
};
export const actions = {
    changePassword: async ({ request, locals, cookies }) => {
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const currentPassword = String(form.get("currentPassword") ?? "");
        const newPassword = String(form.get("newPassword") ?? "");
        const confirm = String(form.get("confirm") ?? "");
        if (newPassword !== confirm) {
            return fail(400, { error: "The two new passwords don't match." });
        }
        const result = await execute(registry, adapter, locals.ctx, "users.change_password", {
            currentPassword,
            newPassword,
            // Keep THIS session alive; the op revokes the actor's other sessions.
            keepSessionToken: cookies.get(SESSION_COOKIE),
        });
        if (!result.ok) {
            return fail(400, { error: opErrorMessage(result.error, "Could not change your password.") });
        }
        return { ok: true };
    },
};

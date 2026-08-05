// SPDX-License-Identifier: MPL-2.0
/**
 * v0.2.26 — Owner queue for AI-proposed ai_providers changes.
 *
 * Approve action collects the API key inline via the form when a `set`
 * proposal needs one (no existing key, or Owner wants to rotate).
 * The proposal payload never contained the key; the Owner-supplied
 * field is merged in at execute_proposal time.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "ai_providers.list_pending", {});
    const proposals = r.ok ? r.value.proposals : [];
    return { proposals };
};
export const actions = {
    approve: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const apiKey = form.get("apiKey");
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "ai_providers.execute_proposal", {
            proposalId,
            ...(typeof apiKey === "string" && apiKey.length > 0 ? { apiKey } : {}),
        });
        if (!r.ok) {
            const message = typeof r.error === "object" && r.error && "message" in r.error
                ? String(r.error.message)
                : "approve failed";
            return fail(400, { error: message });
        }
        const v = r.value;
        return {
            ok: true,
            message: v.apiKeyChanged ? "Provider applied; API key updated." : "Provider applied.",
        };
    },
    reject: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const reason = form.get("reason") ? String(form.get("reason")) : undefined;
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "ai_providers.reject_proposal", {
            proposalId,
            ...(reason ? { reason } : {}),
        });
        if (!r.ok) {
            const message = typeof r.error === "object" && r.error && "message" in r.error
                ? String(r.error.message)
                : "reject failed";
            return fail(400, { error: message });
        }
        return { ok: true, message: "Proposal rejected." };
    },
};

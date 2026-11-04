// SPDX-License-Identifier: MPL-2.0
/**
 * Owner queue for AI-proposed Owner-settings changes (AI budgets, AI
 * pricing, gateway settings, translation model, a plugin's AI cost cap,
 * gateway cookie-secret rotation, the staging access gate) —
 * `owner_settings.*` ops, migrations 0235 / 0241 / 0244 / 0251.
 *
 * In the chat the operator approves on the inline card and the row is
 * written + applied atomically, so it never waits here. Rows land here when
 * the proposal came over the Power-MCP (an external agent has no in-chat
 * card), and the chat's proposal card POSTs to these same actions.
 */
import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
function messageOf(e, fallback) {
    return typeof e === "object" && e && "message" in e
        ? String(e.message)
        : fallback;
}
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "owner_settings.list_pending", {});
    // An approval queue that fails to load must not read as "nothing pending".
    if (!r.ok)
        throw error(500, messageOf(r.error, "could not load pending settings proposals"));
    return { proposals: r.value.proposals };
};
export const actions = {
    approve: async ({ request, locals }) => {
        requireApproverPermission(locals, getQueryContext().registry, "owner_settings.execute_proposal");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "owner_settings.execute_proposal", {
            proposalId,
        });
        if (!r.ok)
            return fail(400, { error: messageOf(r.error, "approve failed") });
        const next = r.value.nextStep;
        return { ok: true, message: next ? `Setting applied. ${next}` : "Setting applied." };
    },
    reject: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const reason = form.get("reason") ? String(form.get("reason")) : undefined;
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "owner_settings.reject_proposal", {
            proposalId,
            ...(reason ? { reason } : {}),
        });
        if (!r.ok)
            return fail(400, { error: messageOf(r.error, "reject failed") });
        return { ok: true, message: "Proposal rejected." };
    },
};

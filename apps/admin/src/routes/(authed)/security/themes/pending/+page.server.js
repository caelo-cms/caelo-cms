// SPDX-License-Identifier: MPL-2.0
/**
 * v0.11.0 (#45) — Owner queue for AI-proposed theme actions
 * (create / activate / delete). Mirrors /security/layouts/pending —
 * calls themes.list_pending + themes.{execute,reject}_proposal.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    // Theme edits affect every page on the site — reuse the roles.manage
    // permission as the proxy until the catalogue grows an explicit
    // `themes.write` entry (same shape /security/layouts/pending uses).
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.list_pending", {});
    const proposals = r.ok ? r.value.proposals : [];
    return { proposals };
};
export const actions = {
    approve: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "themes.execute_proposal", {
            proposalId,
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
            message: v.themeId
                ? `Proposal applied (themeId=${v.themeId.slice(0, 8)}…). For activation, also approve a deploy via /security/deployments/pending to push the new CSS live.`
                : "Proposal applied (theme deleted).",
        };
    },
    reject: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const reason = form.get("reason") ? String(form.get("reason")) : undefined;
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "themes.reject_proposal", {
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

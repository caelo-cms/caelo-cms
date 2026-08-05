// SPDX-License-Identifier: MPL-2.0
/**
 * v0.2.23 — Owner queue for AI-proposed snapshot reverts (site / page /
 * template / module). Mirrors layouts/pending shape.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    // Reverts are Owner-gated; reuse the roles.manage permission as the
    // proxy until the catalogue gets an explicit `snapshots.revert` entry.
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "snapshots.list_pending", {});
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
        const r = await execute(registry, adapter, locals.ctx, "snapshots.execute_proposal", {
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
            message: v.siteSnapshotId
                ? `Revert applied (new snapshot=${v.siteSnapshotId.slice(0, 8)}…).`
                : "Revert applied.",
        };
    },
    reject: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const reason = form.get("reason") ? String(form.get("reason")) : undefined;
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "snapshots.reject_proposal", {
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

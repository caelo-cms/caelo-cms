// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
/**
 * P7 — Owner-only media settings: CDN copy toggle + threshold +
 * library stats. Owner-proxy via `roles.manage` until the
 * permission catalogue grows an explicit `media.settings` entry.
 */
export const load = async ({ locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const settings = await execute(registry, adapter, locals.ctx, "media.get_settings", {});
    const cdn = settings.ok
        ? {
            enabled: settings.value
                .cdnCopyEnabled,
            threshold: settings.value
                .cdnUsageThreshold,
        }
        : { enabled: false, threshold: 5 };
    const list = await execute(registry, adapter, locals.ctx, "media.list", {
        sort: "most_used",
        limit: 10,
        offset: 0,
    });
    const stats = list.ok
        ? list.value
        : { assets: [], totalCount: 0 };
    const visibleBytes = stats.assets.reduce((sum, a) => sum + Number(a.sizeBytes), 0);
    // P7 optimization #5 — pending alt-text proposals from the scanner.
    const props = await execute(registry, adapter, locals.ctx, "media.list_alt_proposals", {
        pendingOnly: true,
        limit: 50,
    });
    const altProposals = props.ok
        ? props.value.proposals
        : [];
    return {
        cdn,
        totalAssets: stats.totalCount,
        visibleBytes,
        topAssets: stats.assets,
        altProposals,
    };
};
export const actions = {
    setCdn: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const enabled = form.get("enabled") === "true";
        const threshold = Number(form.get("threshold") ?? "5");
        if (!Number.isInteger(threshold) || threshold < 1) {
            return fail(400, { error: "threshold must be a positive integer" });
        }
        const res = await execute(registry, adapter, locals.ctx, "site_defaults.set_media_cdn", {
            enabled,
            threshold,
        });
        if (!res.ok) {
            const message = typeof res.error === "object" && res.error && "message" in res.error
                ? String(res.error.message)
                : "could not save";
            return fail(400, { error: message });
        }
        return { ok: true, message: "Saved." };
    },
    reviewAlt: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const accept = form.get("accept") === "true";
        const res = await execute(registry, adapter, locals.ctx, "media.review_alt_proposal", {
            proposalId,
            accept,
        });
        if (!res.ok) {
            const message = typeof res.error === "object" && res.error && "message" in res.error
                ? String(res.error.message)
                : "review failed";
            return fail(400, { error: message });
        }
        return { ok: true, message: accept ? "Alt accepted." : "Proposal rejected." };
    },
};

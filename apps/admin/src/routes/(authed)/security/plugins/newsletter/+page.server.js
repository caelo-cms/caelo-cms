// SPDX-License-Identifier: MPL-2.0
import { runPluginOperation } from "@caelo-cms/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    // No `list_subscribers` op shipped — query directly via plugin host's
    // generic `list_aggregates`-style approach is not available either; use
    // a lightweight `_count_subscribers` op if needed. For now, surface the
    // campaign list via raw plugin query (lightweight admin-side enumeration
    // through ctx.cms isn't exposed). We use a special op call.
    // Newsletter doesn't ship a list_subscribers op yet; show campaign list only.
    return {
        campaigns: [],
        subscriberCount: null,
    };
};
export const actions = {
    draft: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const slug = form.get("slug");
        const subject = form.get("subject");
        const brief = form.get("brief");
        if (typeof slug !== "string" || typeof subject !== "string" || typeof brief !== "string") {
            return fail(400, { error: "slug + subject + brief required" });
        }
        const r = await runPluginOperation({
            pluginSlug: "newsletter",
            operationName: "draft_campaign",
            args: { slug, subject, brief },
        });
        if (!r.ok)
            return fail(400, { error: r.error.message });
        return { ok: true, message: "Draft created — visit Campaigns to send." };
    },
    send: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const campaignId = form.get("campaignId");
        if (typeof campaignId !== "string")
            return fail(400, { error: "campaignId required" });
        const r = await runPluginOperation({
            pluginSlug: "newsletter",
            operationName: "send_campaign",
            args: { campaignId },
        });
        if (!r.ok)
            return fail(400, { error: r.error.message });
        const v = r.value;
        return { ok: true, message: `Queued ${v.queued} sends.` };
    },
};

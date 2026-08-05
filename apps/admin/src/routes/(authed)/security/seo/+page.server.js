// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
/**
 * P8 — Owner-only SEO dashboard. Site-level base URL + sitemap toggle
 * + Organization JSON-LD editor + the stale-SEO queue. Owner-proxy via
 * `roles.manage` until the permission catalogue grows an explicit
 * `seo.settings` entry.
 */
export const load = async ({ locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const settings = await execute(registry, adapter, locals.ctx, "site_defaults.get_seo", {});
    const stale = await execute(registry, adapter, locals.ctx, "pages_seo.list_stale", {
        limit: 50,
    });
    return {
        settings: settings.ok
            ? settings.value
            : { siteBaseUrl: "", sitemapEnabled: true, organizationJson: {} },
        stale: stale.ok
            ? stale.value.pages
            : [],
    };
};
export const actions = {
    saveSettings: async ({ request, locals }) => {
        requirePermission(locals, "roles.manage");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const siteBaseUrl = String(form.get("siteBaseUrl") ?? "");
        const sitemapEnabled = form.get("sitemapEnabled") === "on";
        const organizationJsonRaw = String(form.get("organizationJson") ?? "{}");
        let organizationJson;
        try {
            const parsed = JSON.parse(organizationJsonRaw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return fail(400, { error: "organizationJson must be a JSON object" });
            }
            organizationJson = parsed;
        }
        catch {
            return fail(400, { error: "organizationJson is not valid JSON" });
        }
        const r = await execute(registry, adapter, locals.ctx, "site_defaults.set_seo", {
            siteBaseUrl,
            sitemapEnabled,
            organizationJson,
        });
        if (!r.ok) {
            const message = typeof r.error === "object" && r.error && "message" in r.error
                ? String(r.error.message)
                : "save failed";
            return fail(400, { error: message });
        }
        return { ok: true, message: "Saved." };
    },
};

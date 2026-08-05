// SPDX-License-Identifier: MPL-2.0
/**
 * P14 — domains registry. Real now (placeholder before).
 *  - Lists every hostname the gateway / static site serves.
 *  - Owner can add / remove / verify-DNS-now.
 *  - cms-provision regenerate-caddy reads the same table at deploy.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "domains.list", {});
    const domains = r.ok ? r.value.domains : [];
    return { domains, error: r.ok ? null : r.error.kind };
};
export const actions = {
    add: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const hostname = form.get("hostname") ?? "";
        const kind = form.get("kind") ?? "public";
        const localeCode = form.get("localeCode") ?? "";
        if (!["admin", "public", "locale-public"].includes(kind)) {
            return fail(400, { error: "kind must be admin/public/locale-public" });
        }
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "domains.add", {
            hostname,
            kind,
            ...(kind === "locale-public" && localeCode ? { localeCode } : {}),
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return {
            ok: true,
            message: `Added ${hostname}. Run \`bunx cms-provision regenerate-caddy\` so Caddy picks up the new vhost.`,
        };
    },
    remove: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const id = form.get("domainId");
        if (typeof id !== "string")
            return fail(400, { error: "domainId required" });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "domains.remove", {
            domainId: id,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return { ok: true, message: "Domain removed." };
    },
    verify: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const id = form.get("domainId");
        if (typeof id !== "string")
            return fail(400, { error: "domainId required" });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "domains.verify", {
            domainId: id,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        const v = r.value;
        return {
            ok: true,
            message: v.resolved
                ? `${v.hostname} resolves: A=[${v.a.join(", ") || "—"}] AAAA=[${v.aaaa.join(", ") || "—"}]. ACME will pick it up on next Caddy reload.`
                : `${v.hostname} does NOT resolve yet. Add an A or AAAA record at your DNS provider before Caddy can request a cert.`,
        };
    },
};

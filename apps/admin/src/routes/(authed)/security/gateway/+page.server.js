// SPDX-License-Identifier: MPL-2.0
/**
 * P13 — gateway dashboard.
 *  - Recent request log (last 100, status-coded).
 *  - Body-cap + auto-redeploy + captcha provider knobs.
 *  - Cookie secret rotation.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals, url }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const onlyErrors = url.searchParams.get("errors") === "1";
    const [s, r] = await Promise.all([
        execute(registry, adapter, locals.ctx, "gateway.get_settings", {}),
        execute(registry, adapter, locals.ctx, "gateway.list_recent_requests", {
            limit: 100,
            onlyErrors,
        }),
    ]);
    return {
        settings: s.ok
            ? s.value.settings
            : {
                maxBodyBytes: 65536,
                autoRedeployEnabled: false,
                autoRedeployDebounceMs: 12000,
                autoRedeployOpKinds: [],
                captchaProvider: "pow",
                captchaPowTargetPrefix: "000fff",
                cookieSecretSet: false,
                updatedAt: new Date(0).toISOString(),
            },
        requests: r.ok ? r.value.rows : [],
        onlyErrors,
    };
};
export const actions = {
    saveSettings: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const maxBodyBytes = Number.parseInt(form.get("maxBodyBytes") ?? "0", 10);
        const autoRedeployEnabled = form.get("autoRedeployEnabled") === "on";
        const debounceMs = Number.parseInt(form.get("debounceMs") ?? "0", 10);
        const captchaProvider = form.get("captchaProvider") ?? "pow";
        const captchaPowTargetPrefix = form.get("captchaPowTargetPrefix") ?? "000fff";
        if (!["off", "pow", "turnstile", "hcaptcha"].includes(captchaProvider)) {
            return fail(400, { error: "captchaProvider invalid" });
        }
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "gateway.set_settings", {
            maxBodyBytes,
            autoRedeployEnabled,
            autoRedeployDebounceMs: debounceMs,
            autoRedeployOpKinds: [
                "pages.update",
                "comments.moderate",
                "media.publish",
                "pages_seo.set_many",
            ],
            captchaProvider,
            captchaPowTargetPrefix,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return { ok: true, message: "Gateway settings saved." };
    },
    rotateSecret: async ({ locals }) => {
        requirePermission(locals, "settings.write");
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "gateway.rotate_cookie_secret", {});
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return {
            ok: true,
            message: "Cookie secret rotated. All current visitors + sessions are invalidated; users re-login.",
        };
    },
    setOverride: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const pluginSlug = form.get("pluginSlug") ?? "";
        const operation = form.get("operation") ?? "";
        const perVisitorMax = Number.parseInt(form.get("perVisitorMax") ?? "0", 10);
        const windowSeconds = Number.parseInt(form.get("windowSeconds") ?? "0", 10);
        if (!pluginSlug || !operation)
            return fail(400, { error: "pluginSlug + operation required" });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "gateway.set_rate_limit_override", {
            pluginSlug,
            operation,
            perVisitorMax,
            windowSeconds,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return { ok: true, message: "Rate limit override saved." };
    },
};

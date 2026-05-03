// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — gateway dashboard.
 *  - Recent request log (last 100, status-coded).
 *  - Body-cap + auto-redeploy + captcha provider knobs.
 *  - Cookie secret rotation.
 */

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface GatewaySettings {
  maxBodyBytes: number;
  autoRedeployEnabled: boolean;
  autoRedeployDebounceMs: number;
  autoRedeployOpKinds: string[];
  captchaProvider: "off" | "pow" | "turnstile" | "hcaptcha";
  captchaPowTargetPrefix: string;
  cookieSecretSet: boolean;
  updatedAt: string;
}

interface RequestRow {
  id: string;
  pluginSlug: string;
  operation: string;
  statusCode: number;
  durationMs: number;
  bodyBytes: number;
  wasRateLimited: boolean;
  wasHoneypotCaught: boolean;
  captchaPassed: boolean;
  errorKind: string | null;
  createdAt: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
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
      ? (s.value as { settings: GatewaySettings }).settings
      : ({
          maxBodyBytes: 65536,
          autoRedeployEnabled: false,
          autoRedeployDebounceMs: 12000,
          autoRedeployOpKinds: [],
          captchaProvider: "pow",
          captchaPowTargetPrefix: "000fff",
          cookieSecretSet: false,
          updatedAt: new Date(0).toISOString(),
        } as GatewaySettings),
    requests: r.ok ? (r.value as { rows: RequestRow[] }).rows : [],
    onlyErrors,
  };
};

export const actions: Actions = {
  saveSettings: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const maxBodyBytes = Number.parseInt((form.get("maxBodyBytes") as string) ?? "0", 10);
    const autoRedeployEnabled = form.get("autoRedeployEnabled") === "on";
    const debounceMs = Number.parseInt((form.get("debounceMs") as string) ?? "0", 10);
    const captchaProvider = (form.get("captchaProvider") as string) ?? "pow";
    const captchaPowTargetPrefix = (form.get("captchaPowTargetPrefix") as string) ?? "000fff";
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
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Gateway settings saved." };
  },
  rotateSecret: async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "gateway.rotate_cookie_secret", {});
    if (!r.ok) return fail(400, { error: r.error.kind });
    return {
      ok: true,
      message:
        "Cookie secret rotated. All current visitors + sessions are invalidated; users re-login.",
    };
  },
  setOverride: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const pluginSlug = (form.get("pluginSlug") as string) ?? "";
    const operation = (form.get("operation") as string) ?? "";
    const perVisitorMax = Number.parseInt((form.get("perVisitorMax") as string) ?? "0", 10);
    const windowSeconds = Number.parseInt((form.get("windowSeconds") as string) ?? "0", 10);
    if (!pluginSlug || !operation) return fail(400, { error: "pluginSlug + operation required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "gateway.set_rate_limit_override", {
      pluginSlug,
      operation,
      perVisitorMax,
      windowSeconds,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Rate limit override saved." };
  },
};

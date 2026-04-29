// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { lintLocaleConfig } from "@caelo/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const lr = await execute(registry, adapter, locals.ctx, "locales.list", {});
  const sr = await execute(registry, adapter, locals.ctx, "site_settings.get", {});
  const pr = await execute(registry, adapter, locals.ctx, "locales.list_pending", {
    status: "pending",
  });
  const locales = lr.ok
    ? (
        lr.value as {
          locales: {
            code: string;
            displayName: string;
            urlStrategy: "none" | "subdirectory" | "subdomain" | "domain";
            urlHost: string | null;
            isDefault: boolean;
          }[];
        }
      ).locales
    : [];
  const settings = sr.ok
    ? (sr.value as { settings: { advancedUrlRouting: boolean } }).settings
    : { advancedUrlRouting: false };
  const pendingProposals = pr.ok
    ? (
        pr.value as {
          proposals: {
            id: string;
            actionKind: string;
            payload: unknown;
            preview: unknown;
            proposedAt: string;
          }[];
        }
      ).proposals
    : [];
  const lintWarnings = lintLocaleConfig(locales, settings.advancedUrlRouting);
  return { locales, settings, pendingProposals, lintWarnings };
};

export const actions: Actions = {
  toggleAdvanced: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const advanced = form.get("advancedUrlRouting") === "on";
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "site_settings.set", {
      advancedUrlRouting: advanced,
    });
    if (!r.ok) return fail(400, { error: "toggle failed" });
    return { ok: true, message: `Advanced URL routing ${advanced ? "enabled" : "disabled"}.` };
  },
};

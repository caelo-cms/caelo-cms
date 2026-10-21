// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "telemetry.get", {});
  if (!r.ok) throw new Error(opErrorMessage(r.error, "could not read the telemetry settings"));
  const settings = r.value as {
    installPingEnabled: boolean;
    errorReportingEnabled: boolean;
    installId: string | null;
    eventsSentCount: number;
    lastSentAt: string | null;
    updatedAt: string;
  };
  return { settings };
};

export const actions: Actions = {
  set: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const installPingEnabled = form.get("installPingEnabled") === "1";
    const errorReportingEnabled = form.get("errorReportingEnabled") === "1";
    const r = await execute(registry, adapter, locals.ctx, "telemetry.set", {
      installPingEnabled,
      errorReportingEnabled,
    });
    if (!r.ok) {
      return fail(400, {
        error: `Could not save the telemetry settings: ${opErrorMessage(r.error, "the server refused the change")}`,
      });
    }
    const v = r.value as { installId: string | null };
    return { ok: true, installId: v.installId };
  },
  // P16 hardening — testSend moved to /settings/ai/telemetry/preview
  // (server-side endpoint) to keep the preview payload OUT of the
  // SvelteKit form-action hydration cache. Clients fetch from the
  // browser, render once, never re-serialise.
};

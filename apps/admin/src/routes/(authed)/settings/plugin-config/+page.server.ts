// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1645) — Settings → Plugin settings: every active plugin with
 * a declared configuration, and the approval queue of its gated fields.
 * Same `?/approve` + `?/reject` actions as every pending queue page, so the
 * chat's pending strip posts here (proposal-queue-route.ts).
 */

import { configurablePlugins } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  createdAt: string;
  preview: {
    summary?: string;
    pluginSlug?: string;
    reason?: string;
    changes?: { path: string; label: string; before: unknown; after: unknown }[];
  };
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const pending = await execute(registry, adapter, locals.ctx, "plugin_config.list_pending", {});
  if (!pending.ok)
    throw new Error(`plugin_config.list_pending failed: ${JSON.stringify(pending.error)}`);
  return {
    plugins: configurablePlugins(),
    proposals: (pending.value as { proposals: Proposal[] }).proposals,
  };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requireApproverPermission(locals, getQueryContext().registry, "plugin_config.execute_proposal");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugin_config.execute_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
    });
    if (!r.ok) return fail(400, { error: opErrorMessage(r.error, "approve failed") });
    return {
      ok: true,
      message: "Approved. The new values reach the site with the next Stage and Publish live.",
    };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const reason = String(form.get("reason") ?? "").trim();
    const r = await execute(registry, adapter, locals.ctx, "plugin_config.reject_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: opErrorMessage(r.error, "reject failed") });
    return { ok: true, message: "Proposal rejected." };
  },
};

// SPDX-License-Identifier: MPL-2.0

/**
 * Owner queue for plugin proposals (activate / uninstall /
 * revoke_capability) that wait for a decision — the ones an external
 * agent queued over the Power-MCP, where there is no in-chat card. Approve
 * dispatches to the row's own executor; an approved activation is then
 * loaded into the running host, exactly as the in-chat gated tool does.
 * Revoking a grant additionally needs `plugins.install` (checked by the op).
 */

import { loadActivatedPlugin } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "activate" | "uninstall" | "revoke_capability";
  proposedBy: string;
  preview: Record<string, unknown>;
  createdAt: string;
}

function messageOf(e: unknown, fallback: string): string {
  return typeof e === "object" && e && "message" in e
    ? String((e as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "plugins.list_pending_actions", {});
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const kind = String(form.get("kind") ?? "");
    const { adapter, registry } = getQueryContext();
    const executor =
      kind === "activate" ? "plugins.execute_activation" : "plugins.execute_proposal";
    const r = await execute(registry, adapter, locals.ctx, executor, { proposalId });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "approve failed") });
    const v = r.value as { slug: string };
    if (kind === "activate") {
      const live = await loadActivatedPlugin(v.slug);
      if (!live.loaded) {
        return {
          ok: true,
          message: `"${v.slug}" is activated but could not load yet (${live.reason}); it loads on the next restart.`,
        };
      }
      return { ok: true, message: `"${v.slug}" is activated and running.` };
    }
    // A revoke that disabled the plugin already hot-updated the host
    // inside plugins.execute_proposal.
    return { ok: true, message: "Applied." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugins.reject_proposal", {
      proposalId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "reject failed") });
    return { ok: true, message: "Proposal rejected." };
  },
};

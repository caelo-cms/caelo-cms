// SPDX-License-Identifier: MPL-2.0

/**
 * #684 — Owner queue for AI-proposed URL migrations (every page whose public
 * path moves after a URL plugin was activated, deactivated or reconfigured).
 *
 * The chat's pending strip and the approvals inbox send Approve / Reject
 * here (`proposalQueueRoute("url_migrations")`); before this page existed
 * those POSTs answered 404 and a queued migration could never be applied.
 * Same shape as the snapshots queue.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "migrate";
  proposedBy: string;
  preview: Record<string, unknown>;
  createdAt: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals }) => {
  // Applying moves every affected page's URL; the executor requires
  // roles.manage, so the queue is shown to the same people.
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "url_migrations.list_pending", {});
  if (!r.ok) throw new Error(`url_migrations.list_pending failed: ${errorMessage(r.error, "")}`);
  return { proposals: (r.value as { proposals: Proposal[] }).proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requireApproverPermission(
      locals,
      getQueryContext().registry,
      "url_migrations.execute_proposal",
    );
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "url_migrations.execute_proposal", {
      proposalId,
    });
    if (!r.ok) return fail(400, { error: errorMessage(r.error, "approve failed") });
    const v = r.value as { pagesMoved: number; redirectsCreated: number };
    return {
      ok: true,
      message: `Moved ${v.pagesMoved} page${v.pagesMoved === 1 ? "" : "s"}; ${v.redirectsCreated} redirect${v.redirectsCreated === 1 ? "" : "s"} keep the old addresses working.`,
    };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "url_migrations.reject_proposal", {
      proposalId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: errorMessage(r.error, "reject failed") });
    return { ok: true, message: "Proposal rejected. No page moved." };
  },
};

// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.19 — Owner queue for AI-proposed deploy actions.
 *
 * AI proposes a promote / rollback via deploy.propose_*; the row sits
 * here at status='pending'. Owner clicks Approve → form action calls
 * deploy.execute_proposal (human-only) → underlying op runs →
 * status='applied'. Reject → status='rejected'.
 *
 * The propose-time preview (build id, page count, file count) is
 * rendered verbatim so the click decision has full blast-radius
 * context.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "promote" | "rollback";
  proposedBy: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  appliedRunId: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "deploy.trigger");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "deploy.list_pending", {});
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "deploy.execute_proposal", {
      proposalId,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "approve failed";
      return fail(400, { error: message });
    }
    const v = r.value as { runId: string | null };
    return {
      ok: true,
      message: v.runId
        ? `Proposal applied. Deploy run ${v.runId.slice(0, 8)}… in flight.`
        : "Proposal applied.",
    };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "deploy.reject_proposal", {
      proposalId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "reject failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Proposal rejected." };
  },
};

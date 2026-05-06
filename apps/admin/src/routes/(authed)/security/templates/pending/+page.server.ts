// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.28 — Owner queue for AI-proposed template update/delete actions.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "update" | "delete";
  proposedBy: string;
  templateId: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: "pending" | "applied" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  // Templates touch every bound page's render — gate via content.write
  // (the same permission that governs the Templates editor pages).
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "templates.list_pending", {});
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "templates.execute_proposal", {
      proposalId,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "approve failed";
      return fail(400, { error: message });
    }
    const v = r.value as { templateId: string };
    return {
      ok: true,
      message: `Proposal applied (templateId=${v.templateId.slice(0, 8)}…).`,
    };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "templates.reject_proposal", {
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

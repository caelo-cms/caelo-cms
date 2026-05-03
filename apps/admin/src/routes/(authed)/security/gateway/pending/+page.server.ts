// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — AI-proposed rate-limit changes (§11.A queue).
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  pluginSlug: string;
  operation: string;
  proposedMax: number;
  proposedWindowSec: number;
  proposedBy: string;
  createdAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(
    registry,
    adapter,
    locals.ctx,
    "gateway.list_pending_rate_limit_proposals",
    {},
  );
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals, error: r.ok ? null : r.error.kind };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("proposalId");
    if (typeof id !== "string") return fail(400, { error: "proposalId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "gateway.execute_rate_limit_proposal", {
      proposalId: id,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Proposal applied to rate-limit overrides." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("proposalId");
    const reason = form.get("reason");
    if (typeof id !== "string") return fail(400, { error: "proposalId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "gateway.reject_rate_limit_proposal", {
      proposalId: id,
      reason: typeof reason === "string" ? reason : undefined,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Proposal rejected." };
  },
};

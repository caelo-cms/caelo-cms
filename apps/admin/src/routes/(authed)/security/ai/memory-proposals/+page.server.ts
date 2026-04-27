// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_memory.list_proposals", {
    status: "pending",
  });
  const proposals = r.ok
    ? (
        r.value as {
          proposals: {
            id: string;
            slot: string;
            body: string;
            rationale: string;
            createdAt: string;
          }[];
        }
      ).proposals
    : [];
  return { proposals };
};

export const actions: Actions = {
  review: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const decisionRaw = String(form.get("decision") ?? "");
    const decision = decisionRaw === "accept" ? "accept" : "reject";
    const result = await execute(registry, adapter, locals.ctx, "ai_memory.review", {
      proposalId,
      decision,
    });
    if (!result.ok) return fail(400, { error: "Could not record review." });
    return { ok: true };
  },
};

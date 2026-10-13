// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
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

/**
 * Records the Owner's decision. `decision` comes from the page's own form
 * field, or is fixed by the `approve` / `reject` actions the chat's pending
 * strip posts to (`proposalQueueRoute("site_memory")`, #684).
 */
async function review(
  request: Request,
  locals: App.Locals,
  fixed?: "accept" | "reject",
): Promise<ReturnType<typeof fail> | { ok: true }> {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const form = await request.formData();
  await assertCsrfToken(form, locals);
  const proposalId = String(form.get("proposalId") ?? "");
  const decision = fixed ?? (String(form.get("decision") ?? "") === "accept" ? "accept" : "reject");
  const result = await execute(registry, adapter, locals.ctx, "ai_memory.review", {
    proposalId,
    decision,
  });
  if (!result.ok) return fail(400, { error: "Could not record review." });
  return { ok: true };
}

export const actions: Actions = {
  review: ({ request, locals }) => review(request, locals),
  approve: ({ request, locals }) => review(request, locals, "accept"),
  reject: ({ request, locals }) => review(request, locals, "reject"),
};

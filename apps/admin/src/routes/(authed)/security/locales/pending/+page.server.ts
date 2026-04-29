// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const status = (url.searchParams.get("status") ?? "pending") as
    | "pending"
    | "applied"
    | "rejected"
    | "all";
  const r = await execute(registry, adapter, locals.ctx, "locales.list_pending", { status });
  const proposals = r.ok
    ? (
        r.value as {
          proposals: {
            id: string;
            actionKind: "create" | "delete" | "set_default" | "update_strategy";
            payload: unknown;
            preview: unknown;
            proposedBy: string;
            proposedAt: string;
            status: "pending" | "applied" | "rejected" | "superseded";
            decidedBy: string | null;
            decidedAt: string | null;
            decisionNote: string | null;
          }[];
        }
      ).proposals
    : [];
  return { proposals, status };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "locales.execute_proposal", {
      proposalId,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "approve failed";
      return fail(400, { error: message });
    }
    const { redirectsCreated, crossHostShifts } = r.value as {
      redirectsCreated: number;
      crossHostShifts: number;
    };
    const parts: string[] = ["Proposal applied."];
    if (redirectsCreated > 0)
      parts.push(`${redirectsCreated} redirect${redirectsCreated === 1 ? "" : "s"} created.`);
    if (crossHostShifts > 0)
      parts.push(
        `${crossHostShifts} cross-host page${crossHostShifts === 1 ? "" : "s"} need per-provider edge rules at deploy.`,
      );
    return { ok: true, message: parts.join(" ") };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const note = form.get("note") ? String(form.get("note")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "locales.reject_proposal", {
      proposalId,
      note,
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

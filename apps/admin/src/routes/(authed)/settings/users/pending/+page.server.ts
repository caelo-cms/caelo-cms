// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.21 — Owner queue for AI-proposed user lifecycle changes
 * (create / set_roles / delete). Mirrors layouts/pending shape.
 *
 * Approve on a `create` proposal leaves a one-time password for the
 * approver to collect (#971): the "One-time credentials" box on this page
 * (and in the Live Edit chat) generates it on click and shows it once.
 */

import { refusedMembersMessage } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { syncOperatorAccessFromPanel } from "#lib/server/operator-access.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "create" | "set_roles" | "delete";
  proposedBy: string;
  userId: string | null;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: "pending" | "applied" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  // User-lifecycle gate — same permission as the users page itself.
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "users.list_pending", {});
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requireApproverPermission(locals, getQueryContext().registry, "users.execute_proposal");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "users.execute_proposal", {
      proposalId,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "approve failed";
      return fail(400, { error: message });
    }
    const v = r.value as { userId: string | null; credentialHandoff: unknown };
    const access = v.userId
      ? await syncOperatorAccessFromPanel(locals)
      : { ok: true as const, refusedMembers: [] as string[] };
    return {
      ok: true,
      // Google IAP sync outcome; `error` makes the layout toast it loudly.
      ...("error" in access ? { error: access.error } : {}),
      message: `${
        v.credentialHandoff
          ? "Proposal applied. Collect the new user's one-time password below."
          : v.userId
            ? `Proposal applied (userId=${v.userId.slice(0, 8)}…).`
            : "Proposal applied."
      }${
        // #970 — an approved user whose address has no Google account cannot sign in.
        access.refusedMembers.length ? ` ${refusedMembersMessage(access.refusedMembers)}` : ""
      }`,
    };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "users.reject_proposal", {
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

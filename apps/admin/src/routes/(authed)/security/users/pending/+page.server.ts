// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.21 — Owner queue for AI-proposed user lifecycle changes
 * (create / set_roles / delete). Mirrors layouts/pending shape.
 *
 * Approve on a `create` proposal returns a one-time temporary password
 * — surfaced once in the form-action result for the Owner to copy.
 * It is not persisted past this response.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
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
    requirePermission(locals, "roles.manage");
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
    const v = r.value as { userId: string | null; temporaryPassword: string | null };
    return {
      ok: true,
      message: v.userId
        ? `Proposal applied (userId=${v.userId.slice(0, 8)}…).`
        : "Proposal applied.",
      // One-time display: the Owner copies this and shares with the new
      // user out-of-band. Reloading the page does NOT bring it back.
      temporaryPassword: v.temporaryPassword,
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

// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review-pass #4 — auth_config proposal review queue (§11.A).
 * AI submits a proposal via `propose_auth_config`; Owner approves or
 * rejects here. Approve calls the auth plugin's `execute_proposal` op
 * which applies the change to the singleton row.
 */

import { runPluginOperation } from "@caelo-cms/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  proposed_signup_open: boolean;
  proposed_password_min_length: number;
  proposed_by: string;
  status: string;
  created_at: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const r = await runPluginOperation({
    pluginSlug: "auth",
    operationName: "list_pending_proposals",
    args: {},
  });
  const proposals = r.ok ? ((r.value as { proposals: Proposal[] }).proposals ?? []) : [];
  return { proposals, error: r.ok ? null : r.error.message };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("proposalId");
    if (typeof id !== "string") return fail(400, { error: "proposalId required" });
    const r = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "execute_proposal",
      args: { proposalId: id },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    return { ok: true, message: "Proposal applied to auth_config." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("proposalId");
    const reason = form.get("reason");
    if (typeof id !== "string") return fail(400, { error: "proposalId required" });
    const r = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "reject_proposal",
      args: {
        proposalId: id,
        reason: typeof reason === "string" ? reason : undefined,
      },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    return { ok: true, message: "Proposal rejected." };
  },
};

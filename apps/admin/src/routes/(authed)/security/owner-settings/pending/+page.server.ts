// SPDX-License-Identifier: MPL-2.0

/**
 * Owner queue for AI-proposed Owner-settings changes (AI budgets, AI
 * pricing, gateway settings) — `owner_settings.*` ops, migration 0235.
 *
 * In the chat the operator approves on the inline card and the row is
 * written + applied atomically, so it never waits here. Rows land here when
 * the proposal came over the Power-MCP (an external agent has no in-chat
 * card), and the chat's proposal card POSTs to these same actions.
 */

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "set_ai_budget" | "set_ai_pricing" | "set_gateway_settings" | "set_translation_model";
  proposedBy: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  createdAt: string;
  chatSessionId: string | null;
}

function messageOf(e: unknown, fallback: string): string {
  return typeof e === "object" && e && "message" in e
    ? String((e as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "owner_settings.list_pending", {});
  // An approval queue that fails to load must not read as "nothing pending".
  if (!r.ok) throw error(500, messageOf(r.error, "could not load pending settings proposals"));
  return { proposals: (r.value as { proposals: Proposal[] }).proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "owner_settings.execute_proposal", {
      proposalId,
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "approve failed") });
    return { ok: true, message: "Setting applied." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "owner_settings.reject_proposal", {
      proposalId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "reject failed") });
    return { ok: true, message: "Proposal rejected." };
  },
};

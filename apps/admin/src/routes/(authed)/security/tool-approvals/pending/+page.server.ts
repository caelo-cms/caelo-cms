// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W5 — Owner queue for AI tool calls gated by the
 * `needsApproval` predicate on `ToolDefinitionWithHandler`. The
 * dispatcher writes a row to `tool_approval_actions` whenever a
 * gated tool fires; this route surfaces those rows + lets the Owner
 * approve/reject. Approve runs the persisted tool with the persisted
 * args via the same ToolRegistry the chat-runner uses.
 *
 * Mirrors the shape of /security/snapshots/pending +page.server.ts —
 * the approve flow swaps the per-domain `*.execute_proposal` op for
 * a two-step claim-then-dispatch:
 *   1. `tool_approvals.read_for_execute` — atomic pending → applied
 *      transition + returns the persisted args.
 *   2. ToolRegistry.dispatch — runs the tool's handler with the
 *      operator's session ctx (NOT the AI ctx that originally
 *      proposed) so the audit log credits the human approver.
 *   3. `tool_approvals.mark_result` — captures the dispatch outcome
 *      so the queue page shows "applied — succeeded" / "applied —
 *      failed: <reason>".
 */

import { createDefaultToolRegistry } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: Record<string, unknown>;
  chatSessionId: string | null;
  proposedBy: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  resultOk: boolean | null;
  resultSummary: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  // Same permission proxy as the other propose/* queues — the
  // Owner-equivalent role.
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "tool_approvals.list_pending", {});
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

    // Step 1: atomic claim — transitions pending → applied + returns
    // the persisted toolName + args. Re-clicking the Approve button
    // (race condition) returns "proposal already applied".
    const claim = await execute(registry, adapter, locals.ctx, "tool_approvals.read_for_execute", {
      proposalId,
    });
    if (!claim.ok) {
      const message =
        typeof claim.error === "object" && claim.error && "message" in claim.error
          ? String((claim.error as { message: unknown }).message)
          : "approve failed";
      return fail(400, { error: message });
    }
    const { toolName, args, chatSessionId } = claim.value as {
      toolName: string;
      args: Record<string, unknown>;
      chatSessionId: string | null;
    };

    // Step 2: dispatch through the same tool registry the chat-runner
    // uses. ctx is the Owner's session ctx, not the AI ctx — audit
    // shows the human approver as the actor that ran the tool.
    const tools = createDefaultToolRegistry();
    let dispatchResult: { ok: boolean; content: string };
    try {
      dispatchResult = await tools.dispatch(toolName, args, locals.ctx, {
        adapter,
        registry,
        ...(chatSessionId ? { chatSessionId } : {}),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dispatchResult = { ok: false, content: `dispatch threw: ${errMsg}` };
    }

    // Step 3: capture the dispatch outcome so the queue page shows
    // result-aware status without an extra round-trip. Best-effort —
    // failure here doesn't undo the Step 1 'applied' transition.
    await execute(registry, adapter, locals.ctx, "tool_approvals.mark_result", {
      proposalId,
      ok: dispatchResult.ok,
      summary: dispatchResult.content.slice(0, 2000),
    });

    if (!dispatchResult.ok) {
      return fail(400, { error: `Approved but tool returned failure: ${dispatchResult.content}` });
    }
    return {
      ok: true,
      message: `Approved + dispatched: ${toolName}. Result: ${dispatchResult.content.slice(0, 240)}`,
    };
  },

  reject: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "tool_approvals.reject_proposal", {
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

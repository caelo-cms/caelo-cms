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
 *
 * DESIGN CONTRACTS:
 *
 * (a) Live-commit semantics. The dispatch carries `chatSessionId` (so
 *     the audit log links the action back to the chat origin) but
 *     deliberately OMITS `chatBranchId`. Once the Owner approves, the
 *     action commits directly to main — it does NOT branch-write into
 *     the proposing chat. Rationale: gated tools are by definition
 *     hard-to-revert; making them branch-only would mean an Approve
 *     click is a no-op on main until the chat publishes, which is
 *     surprising for destructive ops. If you ship a future gated tool
 *     where branch-write IS the desired semantic, store branchId in
 *     the persisted row and read it here.
 *
 * (b) Built-in tools only. The dispatch uses
 *     `createDefaultToolRegistry()` which is the BUILT-IN catalogue
 *     only — Tier-1 plugin tools registered through
 *     `pluginToolsRegistry` are NOT included. Plugin tools with
 *     `needsApproval` would queue fine but Approve would 400 with
 *     "unknown tool". Lift this constraint by importing
 *     `pluginToolsRegistry` here and folding its entries into the
 *     dispatcher's lookup, mirroring the chat-runner's catalogue
 *     assembly at chat-runner.ts:966.
 *
 * (c) Owner-ctx dispatch + actor-scope mismatch (v0.6.0 alpha.4 Fix R).
 *     The dispatched tool runs with `locals.ctx` (actorKind: "human")
 *     so the audit log credits the Owner who approved. But the
 *     ORIGINAL propose-time dispatch ran with the AI's ctx
 *     (actorKind: "ai"). Tools whose actorScope EXCLUDES "human"
 *     (e.g., the rare `["ai", "system"]` shape) would queue at
 *     propose-time but fail at approve-time with `ActorScopeRejected`.
 *     Every currently-shipped tool with `needsApproval`
 *     (delete_pages_many) has `["human", "ai", "system"]` scope so
 *     this is not a live bug — but a future ai-only gated tool would
 *     need either: (i) the tool widens its actorScope to include
 *     human, OR (ii) the route here passes through the proposer's
 *     ctx with an Owner attribution layered on top.
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

    // v0.6.0 alpha.4 Fix T — propagate the REAL dispatch result back
    // into the chat session as a tool-role message so the AI sees the
    // actual outcome on its next turn (was: only saw a generic
    // "proposal applied" client-side notification). For
    // delete_pages_many specifically: the AI now sees how many pages
    // actually deleted, what was already-deleted, what was not-found
    // — enough to give the user a meaningful follow-up.
    //
    // Best-effort: skip when chatSessionId is missing (out-of-chat
    // approval, currently theoretical) and on append failure (the
    // dispatch already succeeded; the chat-side message is the
    // bonus). Tool-call id `approval-<proposalId>` matches the
    // client-side onProposalApproved synthetic id so de-dup logic
    // upstream stays consistent.
    if (chatSessionId) {
      try {
        await execute(registry, adapter, locals.ctx, "chat.append_message", {
          chatSessionId,
          role: "tool",
          content: `[approved + dispatched by Owner] ${toolName}: ${dispatchResult.content}`.slice(
            0,
            8000,
          ),
          toolCallId: `approval-${proposalId}`,
        });
      } catch (err) {
        console.error("[tool-approvals.approve] chat.append_message failed", {
          proposalId,
          toolName,
          chatSessionId,
          error: err,
        });
      }
    }

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

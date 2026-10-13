// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.63 — Per-chat pending-proposals fetch.
 *
 * The chat page renders a sticky strip at the top showing pending
 * `propose_*` queued from THIS session. ChatPanel calls this endpoint
 * on mount + after every successful tool-result so the strip stays in
 * sync with what the AI just proposed (or what an Owner just clicked
 * Approve on, removing the row).
 *
 * Filtering is client-side trivial — pending_proposals.list returns a
 * cross-domain unified set and includes `chatSessionId` per row. We
 * call the op with the human ctx, filter to params.sessionId, and
 * return the trimmed shape ChatPanel needs (proposalId, domain, kind,
 * summary). The per-domain pending pages keep their own actions; this
 * endpoint is a thin read-projection.
 *
 * Issue #658 — items carry `requestedVia` (an external agent's proposal is
 * not this chat's work), and `handoffs` lists this session's recently
 * decided MCP proposals so the strip can show the hand-back state.
 *
 * Issue #658 (caelo_chat) — `turnApprovals` lists the in-chat approval
 * cards a turn in this chat paused on, whoever's turn it was: this chat's
 * own AI (resumed from the chat stream) or an external agent's caelo_chat
 * turn (`requestedVia: "mcp_chat"`, decided via ../approvals). Their
 * decided external-agent cards join `handoffs`.
 *
 * Scope: GET only. Approve / Reject continue to go through the
 * existing /security/<domain>/pending form actions (the same path
 * ProposeCard uses) so we don't fork the action contract.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { proposalQueueRoute } from "#lib/proposal-queue-route.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

interface PendingItem {
  proposalId: string;
  domain: string;
  kind: string;
  summary: string;
  proposedAt: string;
  /** The domain's pending page — where Approve / Reject post. */
  queueUrl: string;
  /**
   * Issue #658 — "power_mcp" when an external agent queued it: Approve
   * hands the decision back to that agent and must NOT continue this
   * chat's AI.
   */
  requestedVia: "power_mcp" | null;
}

/** A decided MCP-originated proposal from this session (issue #658). */
interface DecidedHandoff {
  proposalId: string;
  summary: string;
  outcome: string;
  decidedAt: string | null;
  /** When the external agent picked the decision up; null while it has not. */
  deliveredAt: string | null;
}

/** An open in-chat approval card (issue #658). */
interface TurnApprovalCard {
  approvalId: string;
  name: string;
  preview: string;
  requiredPermissions: string[];
  /** "mcp_chat" when an external agent's caelo_chat turn paused on it. */
  requestedVia: "mcp_chat" | null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  if (!locals.user) throw error(401, "Not authenticated");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "pending_proposals.list", {
    limit: 200,
  });
  if (!r.ok) {
    return json({
      items: [] satisfies PendingItem[],
      handoffs: [] satisfies DecidedHandoff[],
      turnApprovals: null,
    });
  }
  const v = r.value as {
    items: {
      proposalId: string;
      domain: string;
      kind: string;
      summary: string;
      proposedAt: string;
      chatSessionId: string | null;
      requestedVia: "power_mcp" | null;
    }[];
  };
  const items: PendingItem[] = v.items
    .filter((i) => i.chatSessionId === params.sessionId)
    .map((i) => ({
      proposalId: i.proposalId,
      domain: i.domain,
      kind: i.kind,
      summary: i.summary,
      proposedAt: i.proposedAt,
      queueUrl: proposalQueueRoute(i.domain),
      requestedVia: i.requestedVia,
    }));

  // Issue #658 — decided hand-offs keep a status line in the strip ("result
  // handed back to the external agent") until the agent picked them up.
  // Best-effort like the rest of this read: a failure only hides the lines.
  const h = await execute(registry, adapter, locals.ctx, "mcp_approval_handoffs.list", {
    chatSessionId: params.sessionId,
    withinHours: 1,
  });
  const handoffs: DecidedHandoff[] = h.ok
    ? (
        h.value as {
          handoffs: {
            proposalId: string;
            summary: string;
            outcome: string;
            decidedAt: string | null;
            deliveredAt: string | null;
          }[];
        }
      ).handoffs
        .filter((x) => x.outcome !== "pending")
        .map((x) => ({
          proposalId: x.proposalId,
          summary: x.summary,
          outcome: x.outcome,
          decidedAt: x.decidedAt,
          deliveredAt: x.deliveredAt,
        }))
    : [];
  // Issue #658 — in-chat approval cards. `null` (not []) on a failed read, so
  // the panel keeps the cards it has instead of dropping them.
  const t = await execute(registry, adapter, locals.ctx, "chat.list_turn_approvals", {
    chatSessionId: params.sessionId,
    withinHours: 1,
  });
  let turnApprovals: TurnApprovalCard[] | null = null;
  if (t.ok) {
    const rows = (
      t.value as {
        approvals: {
          approvalId: string;
          source: "live_edit" | "mcp_chat";
          toolName: string;
          preview: string;
          requiredPermissions: string[];
          status: string;
          approved: boolean | null;
          decidedAt: string | null;
          resumedAt: string | null;
        }[];
      }
    ).approvals;
    turnApprovals = rows
      .filter((a) => a.status === "pending")
      .map((a) => ({
        approvalId: a.approvalId,
        name: a.toolName,
        preview: a.preview,
        requiredPermissions: a.requiredPermissions,
        requestedVia: a.source === "mcp_chat" ? "mcp_chat" : null,
      }));
    for (const a of rows) {
      if (a.source !== "mcp_chat" || a.status === "pending") continue;
      handoffs.push({
        proposalId: a.approvalId,
        summary: a.preview.split("\n")[0] ?? a.toolName,
        // A resumed card keeps its decision; the agent's own turn applied it.
        outcome: a.status === "resumed" ? (a.approved ? "approved" : "rejected") : a.status,
        decidedAt: a.decidedAt,
        deliveredAt: a.resumedAt,
      });
    }
  }
  return json({ items, handoffs, turnApprovals });
};

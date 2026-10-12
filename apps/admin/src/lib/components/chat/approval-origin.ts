// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — who asked for a pending proposal decides what the chat does
 * after the operator's Approve/Reject click.
 *
 * A proposal this chat's own AI queued resumes that AI (the "Approved: …
 * please continue" nudge). A proposal an external agent queued over the
 * Power-MCP lands in the same session (the MCP resumes the operator's
 * chat, #620), but its decision goes back to THAT agent — the chat must
 * not start a turn of its own AI, it only reports the hand-back.
 *
 * The editor UI never names an AI vendor (CLAUDE.md §2): the requester is
 * "the external agent (MCP)".
 */

/** Origin of a proposal as `pending_proposals.list` reports it. */
export type RequestedVia = "power_mcp" | null;

/** What the chat does once the operator decided a proposal. */
export interface DecisionFollowUp {
  /** Send the auto-continue nudge to this chat's AI. */
  readonly continueChatAi: boolean;
}

/**
 * Only this chat's own proposals continue this chat's AI, and only on
 * Approve (a Reject never auto-continued — unchanged).
 */
export function followUpAfterDecision(
  requestedVia: RequestedVia,
  action: "approve" | "reject",
): DecisionFollowUp {
  return { continueChatAi: action === "approve" && requestedVia !== "power_mcp" };
}

/** Badge on a pending card the external agent queued. */
export const EXTERNAL_AGENT_LABEL = "Requested by the external agent (MCP)";

/** A decided MCP-originated proposal, as the per-chat pending endpoint returns it. */
export interface DecidedHandoff {
  readonly proposalId: string;
  readonly summary: string;
  readonly outcome: string;
  readonly decidedAt: string | null;
  readonly deliveredAt: string | null;
}

/** The strip's status line for a decided hand-off. */
export function handoffStatusText(h: DecidedHandoff): string {
  const verdict =
    h.outcome === "applied"
      ? "Approved and applied"
      : h.outcome === "failed"
        ? "Approved, but applying it failed"
        : h.outcome === "rejected"
          ? "Rejected"
          : h.outcome === "superseded"
            ? "Superseded"
            : "Withdrawn";
  const handBack =
    h.deliveredAt !== null
      ? "the external agent (MCP) received the result and continues from there."
      : "the result is handed back to the external agent (MCP), waiting for it to pick it up.";
  return `${verdict} — ${handBack}`;
}

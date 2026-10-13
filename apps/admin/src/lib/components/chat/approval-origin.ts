// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — who asked for an approval decides what the chat does after
 * the operator's Approve/Reject click.
 *
 * The rule (maintainer decision, 2026-10):
 *
 *  - **This chat's own AI asked** (an SDK approval card its turn paused on,
 *    or a proposal it queued in the strip): Approve AND Reject continue that
 *    AI — also after the operator pressed Stop. Answering the AI's own
 *    question is the operator's explicit go-ahead for that work; Stop only
 *    drops what was queued before it (turns, auto nudges), and nothing else
 *    restarts the AI.
 *  - **An external agent asked** over MCP — a Power-MCP proposal
 *    (`power_mcp`) or a `caelo_chat` turn that paused in this session
 *    (`mcp_chat`): the click applies / records the decision and the result
 *    goes back to THAT agent. This chat's AI never starts a turn for it; the
 *    transcript only shows a local note (never persisted, so the AI never
 *    reads it as an instruction).
 *
 * The editor UI never names an AI vendor (CLAUDE.md §2): the requester is
 * "the external agent (MCP)".
 */

/**
 * Origin of an approval as the per-chat pending endpoint reports it:
 * `power_mcp` (proposal queued over the Power-MCP), `mcp_chat` (a caelo_chat
 * turn paused on it), `null` (this chat's own AI).
 */
export type RequestedVia = "power_mcp" | "mcp_chat" | null;

/** Whether an external agent asked (its decision never reaches this chat's AI). */
export function isExternalRequest(requestedVia: RequestedVia | undefined): boolean {
  return requestedVia === "power_mcp" || requestedVia === "mcp_chat";
}

/** What the chat does once the operator decided. */
export interface DecisionFollowUp {
  /**
   * Continue this chat's AI with the decision. It is the operator's own
   * action, so it passes (and lifts) the Stop latch.
   */
  readonly continueChatAi: boolean;
}

/** Only this chat's own requests continue this chat's AI — on Approve and on Reject. */
export function followUpAfterDecision(
  requestedVia: RequestedVia | undefined,
  _action: "approve" | "reject",
): DecisionFollowUp {
  return { continueChatAi: !isExternalRequest(requestedVia) };
}

/**
 * How an in-chat (SDK) approval card is decided: this chat's own AI resumes
 * its paused turn from the chat stream; an external agent's card only
 * records the decision — the agent's own call resumes ITS turn.
 */
export function sdkApprovalRoute(requestedVia: RequestedVia | undefined): "resume-turn" | "record" {
  return isExternalRequest(requestedVia) ? "record" : "resume-turn";
}

/**
 * Callers pass either the raw kind ("site_import") or a domain-qualified
 * form ("import.site_import").
 */
export function isImportKind(kind: string | undefined): boolean {
  return kind === "site_import" || kind?.endsWith(".site_import") === true;
}

/**
 * The message that continues this chat's AI after the operator decided a
 * proposal it queued in the strip.
 */
export function ownDecisionMessage(args: {
  kind: string | undefined;
  proposalId: string;
  action: "approve" | "reject";
}): string {
  const id = args.proposalId.slice(0, 8);
  const label = args.kind ? `${args.kind} proposal` : "proposal";
  if (args.action === "reject") {
    return `Rejected: ${label} ${id} was not applied. Adjust your plan, or ask me how to proceed.`;
  }
  // Imports are the one gated domain whose approval starts a BACKGROUND job
  // instead of applying a change — the message must say so or the AI
  // announces results that do not exist yet.
  return isImportKind(args.kind)
    ? `Approved: crawl proposal ${id} — the crawler starts within ~10s and runs in the background. Check the run status and tell me how you'll proceed.`
    : `Approved: ${label} ${id} applied to the chat branch. Please continue with what you were doing.`;
}

/**
 * The transcript note for a decision on an external agent's request. Shown
 * locally only — never sent to or persisted for this chat's AI.
 */
export function externalDecisionNote(action: "approve" | "reject", summary: string): string {
  const what = summary.trim().split("\n")[0]?.trim() || "its request";
  return action === "approve"
    ? `Approved the external agent's (MCP) request: ${what} — the result goes back to that agent, which continues from there. The AI in this chat does not act on it.`
    : `Rejected the external agent's (MCP) request: ${what} — the decision goes back to that agent. The AI in this chat does not act on it.`;
}

/** Badge on a card an external agent asked for. */
export const EXTERNAL_AGENT_LABEL = "Requested by the external agent (MCP)";

/** A decided external-agent request, as the per-chat pending endpoint returns it. */
export interface DecidedHandoff {
  readonly proposalId: string;
  readonly summary: string;
  /**
   * Power-MCP proposals: applied | failed | rejected | superseded | withdrawn.
   * caelo_chat cards: approved | rejected | superseded (the agent's own turn
   * applies an approved one when it resumes).
   */
  readonly outcome: string;
  readonly decidedAt: string | null;
  /** When the external agent picked the decision up (or resumed its turn). */
  readonly deliveredAt: string | null;
}

/** The strip's status line for a decided external-agent request. */
export function handoffStatusText(h: DecidedHandoff): string {
  if (h.outcome === "superseded" && h.decidedAt === null) {
    return "Dropped — a newer message in this chat moved on before it was decided.";
  }
  const verdict =
    h.outcome === "applied"
      ? "Approved and applied"
      : h.outcome === "approved"
        ? "Approved"
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

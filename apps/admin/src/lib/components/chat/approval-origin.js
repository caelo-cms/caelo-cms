// SPDX-License-Identifier: MPL-2.0
/** Whether an external agent asked (its decision never reaches this chat's AI). */
export function isExternalRequest(requestedVia) {
    return requestedVia === "power_mcp" || requestedVia === "mcp_chat";
}
/** Only this chat's own requests continue this chat's AI — on Approve and on Reject. */
export function followUpAfterDecision(requestedVia, _action) {
    return { continueChatAi: !isExternalRequest(requestedVia) };
}
/**
 * Whether a decision on this chat's own request may still continue its AI:
 * not when the operator pressed Stop after clicking it (the Stop is the
 * newer action, codex review). A decision clicked after the Stop continues.
 * Generations count this tab's Stops.
 */
export function decisionStillCurrent(stopGenerationAtClick, stopGenerationNow) {
    return stopGenerationAtClick === stopGenerationNow;
}
/**
 * How an in-chat (SDK) approval card is decided: this chat's own AI resumes
 * its paused turn from the chat stream; an external agent's card only
 * records the decision — the agent's own call resumes ITS turn.
 */
export function sdkApprovalRoute(requestedVia) {
    return isExternalRequest(requestedVia) ? "record" : "resume-turn";
}
/**
 * Callers pass either the raw kind ("site_import") or a domain-qualified
 * form ("import.site_import").
 */
export function isImportKind(kind) {
    return kind === "site_import" || kind?.endsWith(".site_import") === true;
}
/**
 * The message that continues this chat's AI after the operator decided a
 * proposal it queued in the strip.
 */
export function ownDecisionMessage(args) {
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
export function externalDecisionNote(action, summary) {
    const what = summary.trim().split("\n")[0]?.trim() || "its request";
    return action === "approve"
        ? `Approved the external agent's (MCP) request: ${what} — the result goes back to that agent, which continues from there. The AI in this chat does not act on it.`
        : `Rejected the external agent's (MCP) request: ${what} — the decision goes back to that agent. The AI in this chat does not act on it.`;
}
/** Badge on a card an external agent asked for. */
export const EXTERNAL_AGENT_LABEL = "Requested by the external agent (MCP)";
/** The strip's status line for a decided external-agent request. */
export function handoffStatusText(h) {
    if (h.outcome === "superseded" && h.decidedAt === null) {
        return "Dropped — a newer message in this chat moved on before it was decided.";
    }
    const verdict = h.outcome === "applied"
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
    const handBack = h.deliveredAt !== null
        ? "the external agent (MCP) received the result and continues from there."
        : "the result is handed back to the external agent (MCP), waiting for it to pick it up.";
    return `${verdict} — ${handBack}`;
}

// SPDX-License-Identifier: MPL-2.0
/**
 * The open fix offer of the chat's newest audit, or null — none while the
 * check runs, after it passed, once the operator decided (fix sent or
 * "Not now"), or when the server sends a plain status note instead.
 */
export function openQualityOffer(status) {
    if (!status?.audit || status.notified)
        return null;
    const f = status.feedback;
    if (f?.kind !== "offer")
        return null;
    return {
        auditRunId: status.audit.id,
        text: f.text,
        actionLabel: f.actionLabel,
        groups: f.groups,
        autoContinue: f.autoContinue,
    };
}
/**
 * #771 — the offer whose fix round the panel starts on its own now, or null:
 * only an `autoContinue` offer, never twice for one audit, and never into a
 * running turn, a pending card action or a half-typed message.
 */
export function autoContinueOffer(offer, state) {
    if (!offer?.autoContinue || state.streaming || state.acting)
        return null;
    if (state.composer.trim().length > 0 || state.started.has(offer.auditRunId))
        return null;
    return offer;
}
/**
 * Whether the panel should deliver the feedback of `status` on its own: only
 * status notes are. An offer waits for the operator (#685).
 */
export function autoDeliverableNote(status) {
    if (!status?.audit || status.notified)
        return null;
    return status.feedback?.kind === "note" ? status.audit.id : null;
}
/** An external agent working in the chat right now (it would refuse a Live Edit turn). */
export function workingExternalAgent(runs) {
    return runs?.find((r) => r.kind === "mcp" && r.state === "running" && !r.cancelRequested) ?? null;
}
/** What the card says when "Fix with AI" is refused because an external agent works here. */
export function externalAgentRefusal(agent) {
    return (`The AI was not started: an external agent (${agent.label}) is working in this chat right now, ` +
        "and two agents editing the same pages would undo each other's work. Stop it in the 'Agents running' bar above (or wait until it is done), then click again.");
}
/**
 * #727 — what a group-level click covers: the whole group, or the pages
 * the operator ticked under "Pick pages". Null when a pick has no page
 * ticked (nothing to act on).
 */
export function groupSelection(group, picked) {
    if (picked === null)
        return { key: group.key };
    const pagePaths = group.pages.map((p) => p.pagePath).filter((path) => picked.has(path));
    if (pagePaths.length === 0)
        return null;
    return pagePaths.length === group.pages.length
        ? { key: group.key }
        : { key: group.key, pagePaths };
}
/** How many pages a selection covers, for the card's button labels. */
export function selectionPageCount(group, selection) {
    return selection.pagePaths?.length ?? group.pages.length;
}
/** The shortest reason an acceptance takes (the server requires 3 chars). */
export const MIN_ACCEPT_REASON = 3;

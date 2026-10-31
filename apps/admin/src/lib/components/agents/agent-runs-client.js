// SPDX-License-Identifier: MPL-2.0
/**
 * Issues #664 / #665 — client half of the running-agents surfaces (the Live
 * Edit bar and the header indicator): the row shape, the fetches, and the
 * wording. Pure functions where possible so they are unit-testable.
 */
import { liveFetch } from "#lib/live/live-refresh.js";
/** Rows that are actually doing (or about to do) work — the indicator's count. */
export function activeRuns(runs) {
    return runs.filter((r) => r.state !== "stopped" && !r.cancelRequested);
}
/** Short status for a row ("working · 2 min", "waiting", "stopping…", "stopped"). */
export function runStatusText(run, nowMs) {
    if (run.state === "stopped")
        return "stopped — blocked in this chat";
    if (run.cancelRequested)
        return "stopping…";
    if (run.state === "queued")
        return "waiting for the chat";
    const since = run.kind === "mcp" ? run.heartbeatAt : run.createdAt;
    const secs = Math.max(0, Math.round((nowMs - Date.parse(since)) / 1000));
    const age = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
    return run.kind === "mcp" ? `working · last action ${age} ago` : `working · ${age}`;
}
/**
 * GET the running agents (one chat, or every chat the operator manages),
 * with the live reads' deadline (#1215): a slow admin answers `null`
 * instead of leaving the request open.
 */
export async function fetchAgentRuns(chatSessionId) {
    const url = chatSessionId ? `/content/chat/${chatSessionId}/agents` : "/api/agents";
    try {
        const res = await liveFetch(url, { headers: { accept: "application/json" } });
        if (!res.ok)
            return null;
        return (await res.json()).runs;
    }
    catch {
        return null;
    }
}
/**
 * Stop (`action: "cancel"`, no runId = everything in the chat) or allow a
 * stopped external agent again. Returns an error message, or null on success.
 */
export async function postAgentAction(args) {
    try {
        const res = await fetch(`/content/chat/${args.chatSessionId}/agents`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": args.csrfToken },
            body: JSON.stringify({ action: args.action, ...(args.runId ? { runId: args.runId } : {}) }),
        });
        if (res.ok)
            return null;
        return (await res.text()) || `Request failed (${res.status})`;
    }
    catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}
/**
 * Issue #664 — may a message start an AI turn right now? After the operator
 * pressed Stop, only their own action (typed message, chip click, Approve)
 * does; every auto-sent nudge is held back. The server enforces the same
 * rule; this keeps the panel from even trying.
 */
export function mayStartTurn(trigger, operatorStopped) {
    return trigger === "operator" || !operatorStopped;
}
/** The status note shown instead of an auto message Stop held back. */
export function heldBackNote(text) {
    return `Not sent to the AI because you stopped it: "${text.length > 160 ? `${text.slice(0, 160)}…` : text}" — send a message when you want it to continue.`;
}

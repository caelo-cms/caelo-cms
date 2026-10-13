// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — client half of the running-agents surfaces (the Live
 * Edit bar and the header indicator): the row shape, the fetches, and the
 * wording. Pure functions where possible so they are unit-testable.
 */

/** One running agent, as `chat.list_agent_runs` returns it. */
export interface AgentRunView {
  id: string;
  chatSessionId: string;
  chatTitle: string;
  kind: "turn" | "subagent" | "mcp";
  source: "live_edit" | "mcp_chat" | "power_mcp" | "subagent";
  label: string;
  state: "queued" | "running" | "stopped";
  parentRunId: string | null;
  createdAt: string;
  heartbeatAt: string;
  cancelRequested: boolean;
}

/** Rows that are actually doing (or about to do) work — the indicator's count. */
export function activeRuns(runs: readonly AgentRunView[]): AgentRunView[] {
  return runs.filter((r) => r.state !== "stopped" && !r.cancelRequested);
}

/** Short status for a row ("working · 2 min", "waiting", "stopping…", "stopped"). */
export function runStatusText(run: AgentRunView, nowMs: number): string {
  if (run.state === "stopped") return "stopped — blocked in this chat";
  if (run.cancelRequested) return "stopping…";
  if (run.state === "queued") return "waiting for the chat";
  const since = run.kind === "mcp" ? run.heartbeatAt : run.createdAt;
  const secs = Math.max(0, Math.round((nowMs - Date.parse(since)) / 1000));
  const age = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
  return run.kind === "mcp" ? `working · last action ${age} ago` : `working · ${age}`;
}

/** GET the running agents (one chat, or every chat the operator manages). */
export async function fetchAgentRuns(chatSessionId?: string): Promise<AgentRunView[] | null> {
  const url = chatSessionId ? `/content/chat/${chatSessionId}/agents` : "/api/agents";
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return ((await res.json()) as { runs: AgentRunView[] }).runs;
  } catch {
    return null;
  }
}

/**
 * Stop (`action: "cancel"`, no runId = everything in the chat) or allow a
 * stopped external agent again. Returns an error message, or null on success.
 */
export async function postAgentAction(args: {
  csrfToken: string;
  chatSessionId: string;
  action: "cancel" | "allow";
  runId?: string;
}): Promise<string | null> {
  try {
    const res = await fetch(`/content/chat/${args.chatSessionId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": args.csrfToken },
      body: JSON.stringify({ action: args.action, ...(args.runId ? { runId: args.runId } : {}) }),
    });
    if (res.ok) return null;
    return (await res.text()) || `Request failed (${res.status})`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Issue #664 — may a message start an AI turn right now? After the operator
 * pressed Stop, only their own action (typed message, chip click, Approve)
 * does; every auto-sent nudge is held back. The server enforces the same
 * rule; this keeps the panel from even trying.
 */
export function mayStartTurn(trigger: "operator" | "auto", operatorStopped: boolean): boolean {
  return trigger === "operator" || !operatorStopped;
}

/** The status note shown instead of an auto message Stop held back. */
export function heldBackNote(text: string): string {
  return `Not sent to the AI because you stopped it: "${text.length > 160 ? `${text.slice(0, 160)}…` : text}" — send a message when you want it to continue.`;
}

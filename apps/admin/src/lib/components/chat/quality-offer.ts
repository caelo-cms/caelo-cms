// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #685 — the chat's "Let the AI fix them?" card for a quality check
 * that found problems. Pure decisions, unit-tested; ChatPanel wires them.
 *
 * Nothing here starts the AI. The card is only ever an offer: the turn runs
 * when the operator clicks its button (an explicit operator action, so it
 * may lift the Stop latch of #672), and is refused while an external agent
 * works in the chat (#682: one agent per chat).
 */

import type { AgentRunView } from "#lib/components/agents/agent-runs-client.js";
import type {
  QualityGroupSelection,
  QualityProblemGroup,
  QualityStatus,
} from "#lib/components/edit/quality-status.svelte.js";

/** The fix offer the card shows. */
export interface QualityFixOffer {
  readonly auditRunId: string;
  /** Card text: what was found, where, who staged, and the question. */
  readonly text: string;
  /** "Fix all with AI", or "Keep fixing with AI" after the fix-round cap. */
  readonly actionLabel: string;
  /** #727 — the open problems by group; each is fixed, accepted or picked. */
  readonly groups: readonly QualityProblemGroup[];
}

/**
 * The open fix offer of the chat's newest audit, or null — none while the
 * check runs, after it passed, once the operator decided (fix sent or
 * "Not now"), or when the server sends a plain status note instead.
 */
export function openQualityOffer(status: QualityStatus | null): QualityFixOffer | null {
  if (!status?.audit || status.notified) return null;
  const f = status.feedback;
  if (f?.kind !== "offer") return null;
  return {
    auditRunId: status.audit.id,
    text: f.text,
    actionLabel: f.actionLabel,
    groups: f.groups,
  };
}

/**
 * Whether the panel should deliver the feedback of `status` on its own: only
 * status notes are. An offer waits for the operator (#685).
 */
export function autoDeliverableNote(status: QualityStatus | null): string | null {
  if (!status?.audit || status.notified) return null;
  return status.feedback?.kind === "note" ? status.audit.id : null;
}

/** An external agent working in the chat right now (it would refuse a Live Edit turn). */
export function workingExternalAgent(runs: readonly AgentRunView[] | null): AgentRunView | null {
  return runs?.find((r) => r.kind === "mcp" && r.state === "running" && !r.cancelRequested) ?? null;
}

/** What the card says when "Fix with AI" is refused because an external agent works here. */
export function externalAgentRefusal(agent: AgentRunView): string {
  return (
    `The AI was not started: an external agent (${agent.label}) is working in this chat right now, ` +
    "and two agents editing the same pages would undo each other's work. Stop it in the 'Agents running' bar above (or wait until it is done), then click again."
  );
}

/**
 * #727 — what a group-level click covers: the whole group, or the pages
 * the operator ticked under "Pick pages". Null when a pick has no page
 * ticked (nothing to act on).
 */
export function groupSelection(
  group: QualityProblemGroup,
  picked: ReadonlySet<string> | null,
): QualityGroupSelection | null {
  if (picked === null) return { key: group.key };
  const pagePaths = group.pages.map((p) => p.pagePath).filter((path) => picked.has(path));
  if (pagePaths.length === 0) return null;
  return pagePaths.length === group.pages.length
    ? { key: group.key }
    : { key: group.key, pagePaths };
}

/** How many pages a selection covers, for the card's button labels. */
export function selectionPageCount(
  group: QualityProblemGroup,
  selection: QualityGroupSelection,
): number {
  return selection.pagePaths?.length ?? group.pages.length;
}

/** The shortest reason an acceptance takes (the server requires 3 chars). */
export const MIN_ACCEPT_REASON = 3;

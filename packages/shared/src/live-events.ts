// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the editor's live-refresh vocabulary. CLAUDE.md §11.B:
 * clients must not poll the admin on a timer, because every request keeps an
 * instance up. Instead the admin tells an open editor WHAT changed, as a
 * topic, and the editor re-reads that one surface through its usual read
 * endpoint (`/content/chat/<id>/pending`, `/api/agents`, …).
 *
 * A topic is a hint, never data: it carries no ids, no rows and no actor, so
 * it is safe to hand to every signed-in tab. The read that follows goes
 * through the endpoint's own permission checks.
 *
 * Topics come from the names of operations that committed (the Query API's
 * `observeCommittedOperations`). Only WRITE operations are listed: a read
 * classified as a change would make every refresh announce another change.
 */

/** One surface an editor tab may need to re-read. */
export const LIVE_TOPICS = [
  /** Running agents (turns, subagents, external MCP agents). */
  "agents",
  /** Pending approvals: queued proposals and paused in-chat approval cards. */
  "pending",
  /** One-time credentials an approval left for the operator (#971). */
  "credentials",
  /** Quality-audit status and the Publish gate (#553). */
  "quality",
  /** Site-import crawl progress (#228). */
  "crawl",
  /** Deploy runs (Stage, Publish live, rollback). */
  "deploys",
] as const;

export type LiveTopic = (typeof LIVE_TOPICS)[number];

const TOPIC_SET: ReadonlySet<string> = new Set(LIVE_TOPICS);

/** Is `value` a known topic? */
export function isLiveTopic(value: string): value is LiveTopic {
  return TOPIC_SET.has(value);
}

/**
 * Parse a comma-separated topic list (a query parameter). Unknown names are
 * an error, not dropped: a client asking for a topic the server does not
 * know would otherwise wait for an event that can never come.
 */
export function parseLiveTopics(
  raw: string | null,
): { ok: true; topics: LiveTopic[] } | { ok: false; unknown: string[] } {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = names.filter((n) => !isLiveTopic(n));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, topics: [...new Set(names)] as LiveTopic[] };
}

// Write ops per topic. Heartbeats (`chat.heartbeat_agent_run`,
// `chat.renew_turn_lease`) and the audit worker's idle `claim_next` are left
// out on purpose: they commit on a clock, and a hint on a clock is the very
// polling this replaces.
const EXACT: Readonly<Record<string, readonly LiveTopic[]>> = {
  "chat.register_agent_run": ["agents"],
  "chat.finish_agent_run": ["agents"],
  "chat.cancel_agents": ["agents"],
  "chat.allow_external_agent": ["agents"],
  // An external agent's tool call: first sight of it lists it as running,
  // and it may have queued a card.
  "chat.touch_external_agent": ["agents", "pending"],
  "chat.record_turn_approvals": ["pending"],
  "chat.decide_turn_approval": ["pending"],
  "chat.supersede_turn_approvals": ["pending"],
  "chat.claim_turn_approvals": ["pending"],
  // Proposal flows whose op names do not follow propose_* / *_proposal.
  "skills.review_proposal": ["pending"],
  "gateway.execute_rate_limit_proposal": ["pending"],
  "gateway.reject_rate_limit_proposal": ["pending"],
  "plugins.approve_installation": ["pending"],
  "credentials.issue": ["credentials"],
  "chat.stage": ["quality", "deploys"],
  "chat.unstage": ["quality"],
  "chat.finalize_stage": ["quality", "deploys"],
  "chat.finalize_draft_stage": ["quality", "deploys"],
  "chat.publish": ["quality", "deploys"],
  "quality_audits.enqueue": ["quality"],
  "quality_audits.record_result": ["quality"],
  "quality_audits.retry": ["quality"],
  "quality_audits.claim_chat_notification": ["quality"],
  "quality_audits.ack_chat_notification": ["quality"],
  "quality_audits.release_chat_notification": ["quality"],
  "quality_audits.publish_anyway": ["quality"],
  "imports.create_run": ["crawl"],
  "imports.update_run_status": ["crawl"],
  "imports.write_extracted_pages": ["crawl"],
  "deploy.trigger": ["deploys"],
  "deploy.begin_run": ["deploys"],
  "deploy.update_progress": ["deploys"],
  "deploy.promote": ["deploys"],
  "deploy.rollback": ["deploys"],
  "deploy.build_plugin_data": ["deploys"],
};

/**
 * The topics a committed operation touches (empty for every other op).
 *
 * Every proposal op (`<domain>.propose_*`, `.execute_proposal`,
 * `.reject_proposal`, `.cancel_proposal`) moves the pending strip; an
 * applied proposal may also leave a one-time credential (#971) and, for
 * the quality and deploy domains, move their state.
 *
 * @example liveTopicsOfOperation("users.execute_proposal") // ["pending", "credentials"]
 */
export function liveTopicsOfOperation(operationName: string): readonly LiveTopic[] {
  const exact = EXACT[operationName];
  if (exact) return exact;
  const dot = operationName.lastIndexOf(".");
  const domain = operationName.slice(0, dot);
  const action = operationName.slice(dot + 1);
  const extra: LiveTopic[] =
    domain === "quality_audits" ? ["quality"] : domain === "deploy" ? ["deploys"] : [];
  if (action === "execute_proposal") return ["pending", "credentials", ...extra];
  if (
    action === "propose" ||
    action.startsWith("propose_") ||
    action === "reject_proposal" ||
    action === "cancel_proposal"
  ) {
    return ["pending"];
  }
  return [];
}

// SPDX-License-Identifier: MPL-2.0

/**
 * The reviewed exception lists behind `agent-tool-parity.test.ts`.
 *
 * Product principle (maintainer): an operator never has to do something
 * manually that the agent cannot do — including over the admin Power-MCP.
 * Hard-to-revert actions are fine as Owner-approval cards (CLAUDE.md §11.A).
 *
 * Every entry here is a DELIBERATE, reviewed answer to "this op is open to
 * the AI (or closed to it) — why is that fine?". Adding an entry is a review
 * decision, not a way to silence the guard: the PR that adds one says why.
 */

/**
 * Why an AI-scoped op has no tool that names it directly.
 *
 *  - `covered`  — the AI reaches the op's effect through another tool (the
 *                 bulk sibling, a composite op, a cross-domain aggregator).
 *                 `by` names those tools; the guard checks they exist and are
 *                 on the Power-MCP surface.
 *  - `internal` — not an agent action: chat-runner / request-path plumbing,
 *                 a UI widget's backing read, a plugin-actor path. The op is
 *                 AI-scoped because the runner dispatches it in the AI's
 *                 context, or because the read is harmless — not because the
 *                 model should call it.
 *  - `gap`      — the agent SHOULD be able to do this and cannot yet. Kept
 *                 green deliberately so this PR stays reviewable; `followUp`
 *                 names where it gets closed. Gaps are debt, not design.
 */
export type AiOpException =
  | { readonly kind: "covered"; readonly by: readonly string[]; readonly note: string }
  | { readonly kind: "internal"; readonly reason: string }
  | { readonly kind: "gap"; readonly reason: string; readonly followUp: string };

const PENDING_QUEUE: AiOpException = {
  kind: "covered",
  by: ["list_pending_proposals"],
  note: "per-domain Owner-queue read; `pending_proposals.list` unions every *_pending_actions table (plus site-memory, skill, rate-limit and import-run proposals)",
};

/** Focal point + named crops: wire the pipeline first, then the tools. */
const MEDIA_CURATION_FOLLOW_UP =
  "#614: pass focal point + media_crops to runMediaPipeline, then add the curation tools";

export const AI_OP_EXCEPTIONS: Readonly<Record<string, AiOpException>> = {
  // ── covered by a bulk / composite / aggregate tool ────────────────────
  // issue #620 Part B — the Stage flow (admin-core stageChatSessions) runs
  // these as the AI when it stages; stage_changes is the only way in, and
  // the classification it enqueues is computed inside the flow.
  "chat.merge_to_main": {
    kind: "covered",
    by: ["stage_changes"],
    note: "isolated chats' merge step of the Stage flow (stage/stage-chats.ts)",
  },
  "themes.ensure_favicon_rendition": {
    kind: "covered",
    by: ["deploy_staging", "stage_changes"],
    note: "pre-build step of deploy.trigger: creates the active theme favicon's 64 px rendition when missing",
  },
  "chat.finalize_stage": {
    kind: "covered",
    by: ["stage_changes"],
    note: "isolated chats' finalize step of the Stage flow, after the staging build succeeded",
  },
  "chat.merge_draft_to_main": {
    kind: "covered",
    by: ["stage_changes"],
    note: "the shared draft's selective merge step of the Stage flow",
  },
  "chat.finalize_draft_stage": {
    kind: "covered",
    by: ["stage_changes"],
    note: "the shared draft's finalize step of the Stage flow",
  },
  "quality_audits.enqueue": {
    kind: "covered",
    by: ["stage_changes"],
    note: "the Stage flow queues the audit of the build it made, with the classification classify_stage computed before the merge — never model input",
  },
  "pages.create": {
    kind: "covered",
    by: ["build_page"],
    note: "build_page is the single page-creation tool; pages.build_page delegates to pages.create",
  },
  "pages.update": {
    kind: "covered",
    by: ["update_pages_many"],
    note: "bulk-first: one page = a one-item update_pages_many",
  },
  "pages.set_status": {
    kind: "covered",
    by: ["set_pages_status_many"],
    note: "bulk-first sibling (pages.set_status_many)",
  },
  "pages.delete": {
    kind: "covered",
    by: ["delete_pages_many"],
    note: "bulk-first sibling; pages.delete_many loops the pages.delete handler",
  },
  "modules.delete": {
    kind: "covered",
    by: ["delete_modules_many"],
    note: "bulk-first sibling; both run the same softDeleteModule (branched + AI in-use guard)",
  },
  "media.delete": {
    kind: "covered",
    by: ["delete_media_many"],
    note: "bulk-first sibling with the same in-use guard",
  },
  "media.set_visibility": {
    kind: "covered",
    by: ["set_media_visibility_many"],
    note: "bulk-first sibling (media.set_visibility_many)",
  },
  "redirects.create": {
    kind: "covered",
    by: ["bulk_create_redirects"],
    note: "bulk-first sibling (redirects.create_many)",
  },
  "redirects.delete": {
    kind: "covered",
    by: ["bulk_delete_redirects"],
    note: "bulk-first sibling (redirects.delete_many)",
  },
  "imports.accept_page": {
    kind: "covered",
    by: ["accept_import_pages"],
    note: "bulk-first sibling; imports.accept_pages runs the same acceptImportedPage",
  },
  "layouts.propose_set_blocks": {
    kind: "covered",
    by: ["propose_update_layout"],
    note: "block-set changes are folded into propose_update_layout's optional blocks[]",
  },
  "templates.get": {
    kind: "covered",
    by: ["read_content", "edit_content"],
    note: "template bodies are read through the content-edit registry (getOp templates.get)",
  },
  "ai_memory.list": {
    kind: "covered",
    by: ["site_memory_propose"],
    note: "site memory is loaded into every turn's system prompt (persistence.loadMemory); changes go through site_memory_propose",
  },
  "users.list_pending": PENDING_QUEUE,
  // #970 — the sync job's per-run report. The AI sees it where it acts: every
  // approved user change folds the run's refused members into the tool
  // result (`operatorAccess.refusedMembers` + a warning to relay).
  "users.operator_access_run": {
    kind: "covered",
    by: ["propose_create_user", "propose_set_user_roles", "propose_delete_user"],
    note: "the applied result of each user tool carries the run report's refused members (gated-tools withOperatorAccessSync)",
  },
  "roles.list_pending": PENDING_QUEUE,
  "templates.list_pending": PENDING_QUEUE,
  "snapshots.list_pending": PENDING_QUEUE,
  "ai_providers.list_pending": PENDING_QUEUE,
  "mcp_tokens.list_pending": PENDING_QUEUE,
  "deploy.list_pending": PENDING_QUEUE,
  "themes.list_pending": PENDING_QUEUE,
  "layouts.list_pending": PENDING_QUEUE,
  "email_config.list_pending": PENDING_QUEUE,
  "domains.list_pending": PENDING_QUEUE,
  "plugins.list_pending": PENDING_QUEUE,
  "plugins.list_pending_actions": PENDING_QUEUE,
  "imports.list_pending_proposals": PENDING_QUEUE,
  "gateway.list_pending_rate_limit_proposals": PENDING_QUEUE,
  "owner_settings.list_pending": PENDING_QUEUE,
  "site_defaults.list_pending": PENDING_QUEUE,
  "ai_memory.list_proposals": PENDING_QUEUE,
  "skills.list_proposals": PENDING_QUEUE,

  // ── internal: not an agent action ─────────────────────────────────────
  "chat.append_message": { kind: "internal", reason: "chat-runner transcript persistence" },
  "chat.pin_skills_index": {
    kind: "internal",
    reason:
      "chat-runner fixes which plugin skills a chat's pinned `# Skills` index left out (#1008)",
  },
  "chat.mark_message_interrupted": { kind: "internal", reason: "chat-runner abort bookkeeping" },
  "chat.acquire_turn_lease": {
    kind: "internal",
    reason: "chat-runner turn serialization across admin instances (issue #628)",
  },
  "chat.renew_turn_lease": {
    kind: "internal",
    reason: "chat-runner turn-lease heartbeat (issue #628)",
  },
  "chat.release_turn_lease": {
    kind: "internal",
    reason: "chat-runner turn-lease release at turn end (issue #628)",
  },
  "chat.register_agent_run": {
    kind: "internal",
    reason: "chat-runner / subagent registration in the running-agents table (issues #664, #665)",
  },
  "chat.get_agent_stop_epoch": {
    kind: "internal",
    reason:
      "chat request entry reads the chat's Stop count so a pre-Stop message is not run afterwards (issue #664)",
  },
  "chat.heartbeat_agent_run": {
    kind: "internal",
    reason: "chat-runner heartbeat that also delivers the operator's Stop (issue #664)",
  },
  "chat.finish_agent_run": {
    kind: "internal",
    reason: "chat-runner running-agents row removal at turn end (issue #664)",
  },
  "chat.touch_external_agent": {
    kind: "internal",
    reason: "mcp.execute_tool marks the external agent as working in the chat (issue #665)",
  },
  "chat.list_agent_runs": {
    kind: "internal",
    reason:
      "backing read of the running-agents bar and header indicator (issues #664, #665); agents learn about another working agent from the refusal message instead",
  },
  "chat.set_response_messages": {
    kind: "internal",
    reason: "chat-runner persists the SDK response.messages (CLAUDE.md §12)",
  },
  "chat.cache_tool_result": {
    kind: "internal",
    reason: "tool-call idempotency cache (chat-runner + mcp.execute_tool)",
  },
  "chat.lookup_tool_result": {
    kind: "internal",
    reason: "tool-call idempotency cache (chat-runner + mcp.execute_tool)",
  },
  "chat.summarize": { kind: "internal", reason: "chat-runner history compaction read" },
  "chat.list_sessions": {
    kind: "internal",
    reason:
      "chat picker UI; Power-MCP agents open/resume sessions via mcp.open_session (caelo_open_session)",
  },
  "chat.rename_session": { kind: "internal", reason: "chat sidebar UI (session title)" },
  "chat.archive_session": { kind: "internal", reason: "chat sidebar UI (session lifecycle)" },
  "chat.branch_edited_modules": { kind: "internal", reason: "/edit preview + pending-changes UI" },
  "chat.branch_edited_entities": { kind: "internal", reason: "/edit preview + pending-changes UI" },
  "chat.branch_change_count": { kind: "internal", reason: "/edit toolbar pending-changes pill" },
  "chat.list_active_pages": {
    kind: "internal",
    reason: "/edit page picker (pages with open chats)",
  },
  "chat.list_open_with_pending": { kind: "internal", reason: "unstaged-work banner in the editor" },
  "imports.get_session_budget_state": {
    kind: "internal",
    reason: "chat-runner migration budget gate; the AI reads spend via check_run_budget",
  },
  "redirects.lookup": {
    kind: "internal",
    reason: "visitor request-path redirect resolution (hooks.server); the AI uses find_redirects",
  },
  "page_module_content.get": {
    kind: "internal",
    reason:
      "pre-v0.12 placement-content read kept for plugin actors (#397); the AI reads placement content through content_instances (get_content_instance / read_content)",
  },
  "pages_seo.get": {
    kind: "covered",
    by: ["get_page_seo"],
    note: "single-page SEO read kept for the panel and plugin actors (#591); get_page_seo reads the same fields plus each page's core text through the bulk pages_seo.get_many",
  },
  "page_module_content.list_for_page": {
    kind: "internal",
    reason:
      "pre-v0.12 placement-content read kept for plugin actors (#397); the AI reads placement content through content_instances",
  },
  "snapshots.publish_impact_pages": {
    kind: "internal",
    reason: "publish dialog read; publishing a chat is the operator's review step",
  },
  "ai_providers.any_configured": {
    kind: "internal",
    reason: "layout guard for the 'set up AI' onboarding; an AI that is running is configured",
  },
  "notifications.aggregate": { kind: "internal", reason: "AppShell bell badge count" },
  "media.get_processing_status": {
    kind: "internal",
    reason: "upload progress poller in the media UI",
  },
  "media.list_alt_proposals": {
    kind: "internal",
    reason:
      "Owner review queue for the alt-text scanner's proposals; the AI writes alt text directly with set_media_alt_many",
  },
  "media.get": {
    kind: "internal",
    reason:
      "asset lookup inside generate_image/edit_image and chat attachments; the AI finds assets with find_media",
  },
  "genesis.render_draft": {
    kind: "internal",
    reason:
      "iframe preview route for design drafts; the AI inspects drafts with inspect_design_draft / present_design_variants",
  },
  "fonts.read_chunk": {
    kind: "internal",
    reason:
      "font-file streaming for the font pipeline; the AI works with fonts via find_fonts / inspect_font / acquire_font",
  },
  "subagent_runs.list": {
    kind: "internal",
    reason:
      "subagent run ledger for the chat UI; spawn_subagent(s) returns the child's result to the AI",
  },
  "subagent_runs.get": {
    kind: "internal",
    reason:
      "subagent run ledger for the chat UI; spawn_subagent(s) returns the child's result to the AI",
  },
  "comment_archive.insert": {
    kind: "internal",
    reason:
      "plugin-owned moderation path: reached through the comments plugin's own tool when that plugin is active",
  },
  "comment_archive.list_for_page": {
    kind: "internal",
    reason:
      "plugin-owned moderation path: reached through the comments plugin's own tool when that plugin is active",
  },
  "telemetry.get": {
    kind: "internal",
    reason:
      "telemetry is the Owner's privacy consent surface (telemetry.set is human-only); the agent has no role in it",
  },
  "telemetry.test_send": {
    kind: "internal",
    reason: "previews for the Owner exactly what telemetry would send before they consent",
  },
  "bug_forwarding.get": {
    kind: "internal",
    reason:
      "backs the Owner's consent card on /settings/bugs (bug_forwarding.set is human-only); the agent learns where each report went from the bug_report result and list_bug_reports",
  },
  "bug_forwarding.preview": {
    kind: "internal",
    reason:
      "shows the Owner the exact bytes one bug report would send to the Caelo team before or after they consent",
  },

  // ── #553 quality gate ─────────────────────────────────────────────────
  "quality_audits.list_pending": PENDING_QUEUE,
  "quality_audits.chat_status": {
    kind: "internal",
    reason:
      "backing read of the chat panel's / toolbar's quality poller (newest audit of a chat + the message the chat should get); the agent reads the same state through get_quality_audit and get_publish_gate",
  },

  // ── agent-tool parity, part 2 ─────────────────────────────────────────
  "tool_approvals.list_pending": PENDING_QUEUE,
  // #684 — backs /settings/url_migrations/pending.
  "url_migrations.list_pending": PENDING_QUEUE,
  // Issue #658 — the Live Edit card's backing read; the agent sees the same
  // origin as list_pending_proposals' requestedBy column, and the external
  // agent reads its own outcome via mcp.get_approval_outcome.
  "mcp_approval_handoffs.list": {
    kind: "covered",
    by: ["list_pending_proposals"],
    note: "origin of MCP-queued proposals (requestedBy column); outcome via caelo_await_approval",
  },
  "imports.log_event": {
    kind: "covered",
    by: ["log_import_events"],
    note: "bulk-first sibling (imports.log_events): one finding is a one-item events array",
  },
  "ai_budgets.list": {
    kind: "covered",
    by: ["get_ai_budgets"],
    note: "get_ai_budgets reads ai_budgets.status, which returns every cap + warnAtPct (the list's columns) plus today's spend against it",
  },

  // ── gaps: the agent should be able to do this (follow-ups) ────────────
  "media.set_focal_point": {
    kind: "gap",
    reason:
      "focal point is stored but never rendered: runMediaPipeline is called without crop specs, so a tool would report a change the site never shows",
    followUp: MEDIA_CURATION_FOLLOW_UP,
  },
  "media.add_crop": {
    kind: "gap",
    reason:
      "named crops are stored but no pipeline call emits their variants (no operator UI either)",
    followUp: MEDIA_CURATION_FOLLOW_UP,
  },
  "media.delete_crop": {
    kind: "gap",
    reason:
      "named crops are stored but no pipeline call emits their variants (no operator UI either)",
    followUp: MEDIA_CURATION_FOLLOW_UP,
  },
  "media.list_crops": {
    kind: "gap",
    reason:
      "named crops are stored but no pipeline call emits their variants (no operator UI either)",
    followUp: MEDIA_CURATION_FOLLOW_UP,
  },
};

/**
 * Human-only ops whose `// Why human-only:` justification is deliberately
 * parked while a named follow-up decides their future (e.g. a pending
 * `propose_*` path that would change the honest answer). Each entry is a
 * TODO the owning PR removes; the guard fails on a stale entry once the op
 * is annotated. Empty: every human-only op says why at its definition.
 */
export const HUMAN_ONLY_PENDING: Readonly<Record<string, string>> = {};

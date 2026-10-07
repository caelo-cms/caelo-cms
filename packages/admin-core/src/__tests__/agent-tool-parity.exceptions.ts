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

/** Follow-up owned by the parallel "propose_* for AI budgets/pricing, gateway settings, plugin capabilities" PR. */
const PARALLEL_PROPOSE_PR =
  "follow-up to #578 (which shipped budgets/pricing/gateway-settings proposals): the remaining cost reads, gateway rate-limit/secret ops and plugin-capability proposals";
/** Follow-up for read tools this PR deliberately did not add (each is a small makeReadTool). */
const READ_TOOLS_FOLLOW_UP =
  "follow-up: read tools for operator dashboards (agent-tool parity, part 2)";

export const AI_OP_EXCEPTIONS: Readonly<Record<string, AiOpException>> = {
  // ── covered by a bulk / composite / aggregate tool ────────────────────
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
  "experiments.list_pending": PENDING_QUEUE,
  "plugins.list_pending": PENDING_QUEUE,
  "imports.list_pending_proposals": PENDING_QUEUE,
  "gateway.list_pending_rate_limit_proposals": PENDING_QUEUE,
  "owner_settings.list_pending": PENDING_QUEUE,
  "ai_memory.list_proposals": PENDING_QUEUE,
  "skills.list_proposals": PENDING_QUEUE,

  // ── internal: not an agent action ─────────────────────────────────────
  "chat.append_message": { kind: "internal", reason: "chat-runner transcript persistence" },
  "chat.mark_message_interrupted": { kind: "internal", reason: "chat-runner abort bookkeeping" },
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
  "imports.list_page_clusters": {
    kind: "internal",
    reason:
      "cluster-review tools were retired on purpose in #278 (homepage-first page-type mapping, see tools/index.ts); compose_from_run clusters internally",
  },
  "imports.assign_page_cluster": {
    kind: "internal",
    reason:
      "cluster-review tools were retired on purpose in #278 (homepage-first page-type mapping, see tools/index.ts)",
  },
  "imports.compose_from_run": {
    kind: "internal",
    reason:
      "the ramp-up wizard's one-click compose; the AI migrates through map_external_page_types → build_page per page (the migration skill), which supersedes it",
  },
  "redirects.lookup": {
    kind: "internal",
    reason: "visitor request-path redirect resolution (hooks.server); the AI uses find_redirects",
  },
  "pages.lookup_links_in_modules": {
    kind: "internal",
    reason:
      "runs inside slug changes (link rewriter) + the dashboard incoming-links panel; the AI searches bodies with grep_content",
  },
  "page_module_content.get": {
    kind: "internal",
    reason:
      "pre-v0.12 placement-content read kept for plugin actors (#397); the AI reads placement content through content_instances (get_content_instance / read_content)",
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
  "site_defaults.get_seo": {
    kind: "internal",
    reason:
      "read by the chat-runner context blocks; site-SEO tools are being added by the parallel SEO-settings PR",
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

  // ── gaps: the agent should be able to do this (follow-ups) ────────────
  "quality_audits.classify_stage": {
    kind: "gap",
    reason:
      "the AI cannot ask whether its next Stage will trigger a Lighthouse audit (and why) before telling the operator what to expect; #583 shipped the op AI-scoped without a tool",
    followUp: "#553 quality gate (PR 2/3): add the classify_stage read to quality-audit-tools.ts",
  },
  "tool_approvals.list_pending": {
    kind: "gap",
    reason:
      "needsApproval cards (delete_pages_many, set_migration_budget, cleanup_import_run) are not in pending_proposals.list's UNION, so list_pending_proposals misses them",
    followUp: "follow-up: add tool_approval_actions to the pending_proposals.list aggregator",
  },
  "chat.list_pending_changes": {
    kind: "gap",
    reason:
      "a Power-MCP agent cannot list its own session's unpublished changes before asking the operator to publish",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "snapshots.get_with_entities": {
    kind: "gap",
    reason:
      "history detail (what a snapshot contained) — the AI can revert but not inspect a snapshot",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "snapshots.module_impact": {
    kind: "gap",
    reason:
      "module blast-radius read meant for the AI's edit planning has no tool (list_modules shows placement counts only)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "pages.refresh_current_path": {
    kind: "gap",
    reason: "URL drift repair for one page (plugins call it; the op comment intends AI repair too)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "imports.list": {
    kind: "gap",
    reason: "no way for the AI to list import runs (it only knows run ids it proposed itself)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "imports.log_event": {
    kind: "gap",
    reason:
      "import ledger append is documented as AI-routine but has no tool (add_import_page_notes covers per-page notes only)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "imports.log_events": {
    kind: "gap",
    reason: "bulk ledger append, same as imports.log_event",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "ai_calls.aggregate": {
    kind: "gap",
    reason: "the AI cannot answer 'what did we spend on AI this month?' (cost dashboard read)",
    followUp: PARALLEL_PROPOSE_PR,
  },
  "ai_calls.aggregate_per_plugin": {
    kind: "gap",
    reason: "per-plugin AI spend read (cost dashboard)",
    followUp: PARALLEL_PROPOSE_PR,
  },
  "audit_events.aggregate_by_op_prefix": {
    kind: "gap",
    reason: "per-operation spend breakdown (cost dashboard)",
    followUp: PARALLEL_PROPOSE_PR,
  },
  "ai_budgets.list": {
    kind: "gap",
    reason: "AI budget read (budgets page)",
    followUp: PARALLEL_PROPOSE_PR,
  },
  "gateway.list_rate_limit_profiles": {
    kind: "gap",
    reason: "rate-limit profile read (tune_rate_limit proposes overrides without seeing profiles)",
    followUp: PARALLEL_PROPOSE_PR,
  },
  "gateway.list_recent_requests": {
    kind: "gap",
    reason: "gateway request log read (live dashboard)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "gateway.list_analytics": {
    kind: "gap",
    reason: "gateway traffic analytics read (live dashboard)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "plugins.get": {
    kind: "gap",
    reason: "single-plugin detail read (validator report, manifest) beyond list_plugins' summary",
    followUp: PARALLEL_PROPOSE_PR,
  },
  "email_config.get": {
    kind: "gap",
    reason:
      "SECURITY: returns the transport secrets (Resend API key / SMTP password) unredacted to any AI-scoped caller — needs a redacted read before it gets a tool (or the op should be narrowed); send_test_email reports transport health meanwhile",
    followUp: "follow-up: redact email_config.get for AI actors, then add a read tool",
  },
  "ai_bug_reports.list": {
    kind: "gap",
    reason: "the AI cannot check whether a defect was already reported before calling bug_report",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "media.list_usages": {
    kind: "gap",
    reason: "which modules embed an asset (delete_media_many reports it only on a blocked delete)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "media.get_settings": {
    kind: "gap",
    reason: "media CDN settings read (Owner panel)",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "media.set_focal_point": {
    kind: "gap",
    reason:
      "focal point is documented as AI territory ('center on the model's face') but has no tool",
    followUp: "follow-up: media curation tools (focal point + named crops)",
  },
  "media.add_crop": {
    kind: "gap",
    reason: "named crops — operator-only today",
    followUp: "follow-up: media curation tools (focal point + named crops)",
  },
  "media.delete_crop": {
    kind: "gap",
    reason: "named crops — operator-only today",
    followUp: "follow-up: media curation tools (focal point + named crops)",
  },
  "media.list_crops": {
    kind: "gap",
    reason: "named crops — operator-only today",
    followUp: "follow-up: media curation tools (focal point + named crops)",
  },
  "pages_seo.get": {
    kind: "gap",
    reason: "per-page SEO read (the AI writes SEO but reads it only via the page editor context)",
    followUp: "parallel PR: SEO-settings tools",
  },
  "pages_seo.list_stale": {
    kind: "gap",
    reason: "stale-SEO dashboard tile read (which pages need re-optimizing)",
    followUp: "parallel PR: SEO-settings tools",
  },
  "skills.list_pin_defaults": {
    kind: "gap",
    reason:
      "per-user skill pin defaults are documented as AI-callable ('always pin scoped-edit') but have no tool",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
  "skills.set_pin_defaults": {
    kind: "gap",
    reason:
      "per-user skill pin defaults are documented as AI-callable ('always pin scoped-edit') but have no tool",
    followUp: READ_TOOLS_FOLLOW_UP,
  },
};

/**
 * Human-only ops whose `// Why human-only:` justification is deliberately NOT
 * written in this PR because a parallel PR owns that op's future (most will
 * gain an Owner-approved `propose_*` path, which changes the honest answer).
 * Each entry is a TODO: the owning PR annotates the op (or opens it to the
 * AI through a gated path) and deletes the entry here — the guard fails on a
 * stale entry once the op is annotated.
 */
export const HUMAN_ONLY_PENDING: Readonly<Record<string, string>> = {
  "plugins.set_ai_cost_cap": `TODO(${PARALLEL_PROPOSE_PR}): per-plugin AI cost cap proposal`,
  "gateway.rotate_cookie_secret": `TODO(${PARALLEL_PROPOSE_PR}): gateway secret rotation`,
  "gateway.set_rate_limit_override": `TODO(${PARALLEL_PROPOSE_PR}): direct override vs tune_rate_limit proposal`,
  "gateway.set_rate_limit_profile": `TODO(${PARALLEL_PROPOSE_PR}): rate-limit profiles`,
  "gateway.execute_rate_limit_proposal": `TODO(${PARALLEL_PROPOSE_PR}): Owner Approve click (gateway.ts is that PR's file)`,
  "gateway.reject_rate_limit_proposal": `TODO(${PARALLEL_PROPOSE_PR}): Owner Reject click (gateway.ts is that PR's file)`,
  "plugins.approve_installation": `TODO(${PARALLEL_PROPOSE_PR}): plugin installation lifecycle`,
  "plugins.get_approved_installation": `TODO(${PARALLEL_PROPOSE_PR}): plugin installation lifecycle`,
  "plugins.finalize_installation": `TODO(${PARALLEL_PROPOSE_PR}): plugin installation lifecycle`,
  "plugins.list_installations": `TODO(${PARALLEL_PROPOSE_PR}): plugin installation lifecycle`,
  "plugins.revoke_capability": `TODO(${PARALLEL_PROPOSE_PR}): propose capability revoke`,
  "plugins.reject": `TODO(${PARALLEL_PROPOSE_PR}): plugin lifecycle`,
  "plugins.revalidate": `TODO(${PARALLEL_PROPOSE_PR}): plugin lifecycle`,
};

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the change journal's registry: which `cms_admin` tables
 * write journal rows, under which kind, and why every other table does not.
 * The contract is `docs/dev/state-and-changes.md`.
 *
 * The journal (`entity_changes`, migration 0430) is written by generic row
 * triggers that migrations attach with `caelo_journal_attach(...)`. This
 * file is the readable copy of that set, and the CI test
 * `change-journal-registry.integration.test.ts` holds both in step: every
 * `cms_admin` table must be either journaled here with the exact trigger
 * arguments the database carries, or exempt here with a written reason. A
 * new table that is neither fails CI, so no table can silently fall
 * outside the journal.
 *
 * Plugin storage tables (`plugin_<slug>.*`) are not listed: the host
 * attaches the trigger when it provisions a plugin's schema, under the kind
 * `plugin_storage` keyed on the plugin's id (never on its reusable slug), so
 * a new plugin or domain needs no journal migration.
 */

/** Every kind a journal row can carry. A consumer names the kinds it reads. */
export const JOURNAL_KINDS = [
  "page",
  "page_terms",
  "page_seo",
  "page_layout",
  "page_module_content",
  "module",
  "template",
  "template_blocks",
  "layout",
  "layout_blocks",
  "layout_module",
  "content_instance",
  "list",
  "list_type",
  "page_type",
  "theme",
  "media",
  "media_variant",
  "media_crop",
  "font",
  "redirect",
  "domain",
  "site_defaults",
  "site_settings",
  "site_memory",
  "skill",
  "plugin",
  "plugin_installation",
  "plugin_grant",
  "plugin_file",
  "plugin_row",
  "plugin_storage",
  "snapshot",
] as const;

/** One kind of the journal (`entity_changes.kind`). */
export type JournalKind = (typeof JOURNAL_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(JOURNAL_KINDS);

/** Is `value` a journal kind? */
export function isJournalKind(value: string): value is JournalKind {
  return KIND_SET.has(value);
}

/**
 * How a journaled table's rows map to journal rows (the trigger's
 * arguments, `caelo_journal_attach` in migration 0430):
 *
 * - `row` — a live entity table. The journal row carries the entity id
 *   (`key`), the row's own branch when the table has one (`branch`), and
 *   the chat from the writing transaction's attribution settings.
 * - `snapshot` — an entity snapshot table. Branch, chat and snapshot id
 *   come from the snapshot's `site_snapshots` header, and an inserted
 *   snapshot records the snapshot it replaces on the same line
 *   (`prev_snapshot_id`), so a consumer can diff the two states.
 * - `header` — `site_snapshots` itself: Stage (`staged_at`), undo
 *   (`undone_at`) and lock takeover (`chat_branch_id`) are UPDATEs of it.
 */
export type JournalMode = "row" | "snapshot" | "header";

/** One journaled table, exactly as its trigger is attached. */
export interface JournaledTable {
  readonly kind: JournalKind;
  readonly mode: JournalMode;
  /** The column that holds the entity id (`entity_changes.row_id`). */
  readonly key: string;
  /** The primary-key columns an UPDATE's old and new rows are paired on. */
  readonly pair: readonly string[];
  /** A column naming the entity this row belongs to (`entity_changes.parent_id`). */
  readonly parent?: string;
  /** The row's own branch column (`row` mode only). */
  readonly branch?: string;
  /** The column holding the owning plugin's id. */
  readonly plugin?: string;
}

const row = (
  kind: JournalKind,
  key: string,
  pair: readonly string[],
  extra: Partial<Pick<JournaledTable, "parent" | "branch" | "plugin">> = {},
): JournaledTable => ({ kind, mode: "row", key, pair, ...extra });

const snapshot = (
  kind: JournalKind,
  key: string,
  extra: Partial<Pick<JournaledTable, "parent" | "plugin">> = {},
): JournaledTable => ({ kind, mode: "snapshot", key, pair: ["id"], ...extra });

/**
 * The journaled `cms_admin` tables. Everything an editor, a render, a
 * build or a plugin derives from: content and its snapshots, media,
 * settings that render into pages, redirects, plugins and their grants.
 */
export const JOURNALED_TABLES: Readonly<Record<string, JournaledTable>> = {
  pages: row("page", "id", ["id"], { branch: "chat_branch_id" }),
  page_terms: row("page_terms", "page_id", ["page_id", "list_id", "item_id"]),
  pages_seo: row("page_seo", "page_id", ["page_id"]),
  page_modules: row("page_layout", "page_id", ["page_id", "block_name", "position"]),
  page_module_content: row("page_module_content", "id", ["id"], { parent: "page_id" }),
  modules: row("module", "id", ["id"], { branch: "chat_branch_id" }),
  templates: row("template", "id", ["id"], { branch: "chat_branch_id" }),
  template_blocks: row("template_blocks", "template_id", ["template_id", "name"]),
  layouts: row("layout", "id", ["id"], { branch: "chat_branch_id" }),
  layout_blocks: row("layout_blocks", "layout_id", ["layout_id", "name"]),
  layout_modules: row("layout_module", "layout_id", ["layout_id", "block_name", "position"]),
  content_instances: row("content_instance", "id", ["id"], {
    branch: "chat_branch_id",
    parent: "module_id",
  }),
  lists: row("list", "id", ["id"], { branch: "chat_branch_id" }),
  list_types: row("list_type", "id", ["id"], { branch: "chat_branch_id" }),
  page_types: row("page_type", "id", ["id"], { branch: "chat_branch_id" }),
  themes: row("theme", "id", ["id"]),
  media_assets: row("media", "id", ["id"]),
  media_variants: row("media_variant", "asset_id", ["asset_id", "variant"]),
  media_crops: row("media_crop", "id", ["id"], { parent: "asset_id" }),
  font_assets: row("font", "id", ["id"]),
  redirects: row("redirect", "id", ["id"]),
  domains: row("domain", "id", ["id"]),
  site_defaults: row("site_defaults", "id", ["id"]),
  site_settings: row("site_settings", "id", ["id"]),
  site_ai_memory: row("site_memory", "id", ["id"]),
  skills: row("skill", "id", ["id"]),
  plugins: row("plugin", "id", ["id"]),
  plugin_installation_versions: row("plugin_installation", "id", ["id"], { parent: "plugin_id" }),
  plugin_capability_grants: row("plugin_grant", "id", ["id"], { parent: "plugin_id" }),
  plugin_private_files: row("plugin_file", "id", ["plugin_id", "id"], { plugin: "plugin_id" }),

  site_snapshots: { kind: "snapshot", mode: "header", key: "id", pair: ["id"] },
  page_snapshots: snapshot("page", "page_id"),
  page_layout_snapshots: snapshot("page_layout", "page_id"),
  page_module_content_snapshots: snapshot("page_module_content", "page_module_content_id", {
    parent: "page_id",
  }),
  module_snapshots: snapshot("module", "module_id"),
  template_snapshots: snapshot("template", "template_id"),
  layout_module_snapshots: snapshot("layout_module", "layout_id"),
  content_instance_snapshots: snapshot("content_instance", "content_instance_id"),
  list_snapshots: snapshot("list", "list_id"),
  list_type_snapshots: snapshot("list_type", "list_type_id"),
  page_type_snapshots: snapshot("page_type", "page_type_id"),
  theme_snapshots: snapshot("theme", "theme_id"),
  plugin_row_snapshots: snapshot("plugin_row", "row_id", {
    parent: "table_name",
    plugin: "plugin_id",
  }),
};

const QUEUE = "a proposal queue; its changes reach editors as the op-classified `pending` topic";
const LOG = "an append-only log or history; nothing is derived from it";
const LEASE = "a lease or lock that coordinates processes; nothing is derived from it";
const SECURITY = "identity and permission rows, read per request by the auth layer";
const RUNTIME = "runtime bookkeeping of a process (health, progress, cache)";
const RETIRED = "retired by #1267; no writer remains, migration 0442 drops it";

/**
 * Every `cms_admin` table that writes no journal rows, with the reason.
 * Adding a table here is a decision a reviewer reads, not a default.
 */
export const JOURNAL_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  __drizzle_migrations: "the migration runner's own bookkeeping",
  entity_changes: "the journal itself",
  entity_change_horizons: "the journal's garbage-collection horizons",
  change_consumers: "the journal's consumer cursors",
  domain_events: RETIRED,
  font_usage_changes: RETIRED,
  site_view_generation: RETIRED,
  plugin_event_cursors: RETIRED,

  actors: SECURITY,
  users: SECURITY,
  roles: SECURITY,
  permissions: SECURITY,
  role_permissions: SECURITY,
  user_roles: SECURITY,
  sessions: SECURITY,
  password_reset_tokens: SECURITY,
  owner_bootstrap_tokens: SECURITY,
  mcp_tokens: SECURITY,
  mcp_remote_connections: SECURITY,
  mcp_remote_access_blocks: SECURITY,
  operator_oauth_client: SECURITY,
  credential_handoffs:
    "one-time credentials an approval left; delivered as the `credentials` topic",
  user_preferences: "one person's editor preferences, read only by that person's own requests",
  skill_pin_defaults: "one person's skill pins, read only by that person's own chats",

  audit_events: LOG,
  ai_calls: LOG,
  ai_bug_reports: LOG,
  ai_moduleize_attempts: LOG,
  page_edit_log: LOG,
  import_run_events: LOG,
  platform_update_events: LOG,
  plugin_errors: LOG,
  redirect_syncs: LOG,
  operator_access_sync_runs: LOG,
  link_migration_runs: LOG,
  comment_archive:
    "visitor comments copied from cms_public: untrusted visitor data, nothing is derived from it",

  chat_sessions:
    "conversation metadata; what a chat changed is journaled through its snapshots, its run state reaches editors as the `agents` topic",
  chat_messages: "conversation history (the provider's message log)",
  chat_tool_results: "conversation history (tool results)",
  chat_agent_runs: "running agents; reach editors as the op-classified `agents` topic",
  chat_turn_approvals: "paused approval cards; reach editors as the `pending` topic",
  chat_turn_leases: LEASE,
  chat_entity_locks:
    "cross-branch entity locks; a takeover re-points the snapshots, which are journaled",
  chat_lock_takeovers: LOG,
  chat_branch_publish_marks:
    "which branch states reached main; the Stage that writes it also updates the journaled site_snapshots",
  draft_entity_observations: "which draft entity states a chat has read (conflict detection)",
  subagent_runs: "subagent bookkeeping of a chat turn",
  mcp_approval_handoffs: "approval hand-offs to an MCP client",
  tool_approval_actions: "approval decisions of chat tool calls",
  plugin_tool_approval_bindings: "the binding of an approved plugin tool call to its arguments",
  site_draft: "the shared draft branch's registry row; branch changes are journaled as snapshots",
  genesis_drafts: "design drafts before a site exists; no page renders from them",
  image_requests: "image generation requests; the resulting media asset is journaled",
  media_alt_proposals:
    "alt-text suggestions awaiting review; the accepted alt is journaled on media_assets",
  entity_leases: LEASE,
  deploy_leases: LEASE,
  plugin_activation_leases: LEASE,
  rate_limit_buckets: "visitor and login rate-limit counters",
  rate_limit_profiles: "gateway rate-limit profiles, published to the gateway's projection",
  plugin_rate_limit_overrides:
    "gateway rate-limit overrides, published to the gateway's projection",
  plugin_rate_limit_proposals: QUEUE,

  ai_providers: "Owner AI configuration; read per call, nothing is derived from it",
  ai_budgets: "Owner AI budgets; read per call, nothing is derived from it",
  ai_pricing: "Owner AI pricing; read per call, nothing is derived from it",
  email_config: "Owner email configuration; read per send",
  telemetry_settings: "the install's telemetry consent",
  staging_access:
    "staging access settings, synced to the hosting provider on save (docs/dev/redirects-and-settings-sync.md)",
  provisioning_outputs: "what the provisioner recorded about the install",
  release_check_cache: RUNTIME,
  deploy_targets: "deploy target configuration; read by the deploy ops",
  deploy_runs: "deploy runs; reach editors as the op-classified `deploys` topic",
  redirect_sync_state: RUNTIME,
  static_bakes: "derived build output of plugin-baked regions",
  plugin_data_build_state: RUNTIME,
  plugin_data_stale_pages: "derived: which pages' baked plugin regions are stale",
  plugin_runtime: RUNTIME,
  plugin_schema_migrations: "plugin DDL bookkeeping",
  plugin_schema_provisions: "plugin DDL bookkeeping",
  plugin_private_file_chunks:
    "the bytes of plugin_private_files rows, journaled through the file row",
  public_projection_outbox: "the outbox of the cms_public projection, drained by its publisher",
  platform_update_agent: RUNTIME,
  platform_update_notifications: RUNTIME,
  platform_update_policy: "the Owner's update policy, read by the update scheduler",
  platform_update_requests: "update requests, run by the upgrader job",
  platform_update_scheduler: RUNTIME,

  import_runs: "site-import runs; reach editors as the op-classified `crawl` topic",
  import_pages: "crawled pages of a site import, before they become pages",
  import_run_links: "links found by a site import",
  quality_audit_runs: "quality audits; reach editors as the op-classified `quality` topic",
  quality_audit_pages: "quality audit results per page",
  quality_baselines: "quality baselines per page, written by the audit worker",
  quality_acceptances: "accepted quality findings; reach editors as the `quality` topic",
  site_memory_proposals: QUEUE,
  skill_proposals: QUEUE,

  ai_providers_pending_actions: QUEUE,
  deploy_pending_actions: QUEUE,
  domain_pending_actions: QUEUE,
  email_config_pending_actions: QUEUE,
  layout_pending_actions: QUEUE,
  mcp_token_pending_actions: QUEUE,
  owner_settings_pending_actions: QUEUE,
  plugin_pending_actions: QUEUE,
  quality_pending_actions: QUEUE,
  role_pending_actions: QUEUE,
  site_defaults_pending_actions: QUEUE,
  snapshot_revert_pending_actions: QUEUE,
  template_pending_actions: QUEUE,
  theme_pending_actions: QUEUE,
  url_migration_pending_actions: QUEUE,
  user_pending_actions: QUEUE,
};

/** NOTIFY channel the journal trigger wakes consumers on (payload empty). */
export const JOURNAL_CHANNEL = "caelo_entity_changes";

/** NOTIFY channel carrying operation-classified live topics across instances. */
export const LIVE_TOPICS_CHANNEL = "caelo_live_topics";

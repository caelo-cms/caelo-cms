// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — schema lint: every foreign key of the migrated databases
 * needs a usable index on its referencing side (docs/dev/query-index-gate.md).
 *
 * Deleting (or re-keying) a parent row makes Postgres look up the children
 * by the FK columns — `SELECT 1 FROM ONLY child WHERE fk = $1 FOR KEY SHARE`
 * for NO ACTION / RESTRICT, `UPDATE ONLY … SET fk = NULL` for SET NULL,
 * `DELETE FROM ONLY …` for CASCADE. Without an index whose leading columns
 * are exactly the FK columns, each of those is a full scan of the child,
 * per parent row. A PARTIAL index does not count: the RI statement carries
 * no `WHERE deleted_at IS NULL`, so the planner cannot use it — those FKs
 * look indexed in review and are not.
 *
 * {@link FK_EXEMPTIONS} carries the reasoned exceptions; {@link FK_PENDING}
 * the known gaps a tracked issue closes. A stale entry of either fails the
 * lint. Plugin schemas (`plugin_*`) are created at activation, not by the
 * migrations, so they are left to the plan gate (analyze.ts) and to
 * #1292's automatic `ref:` indexes.
 */

/** One FK of a database, as the lint names it: `<db> <table>(<cols>) -> <referenced>`. */
export interface ForeignKeyRow {
  readonly db: "cms_admin" | "cms_public";
  readonly table: string;
  readonly columns: string;
  readonly references: string;
}

/** The lint's key of a foreign key. */
export function fkKey(fk: ForeignKeyRow): string {
  return `${fk.db} ${fk.table}(${fk.columns}) -> ${fk.references}`;
}

/** A reasoned exemption: by exact key, or every FK onto `references`. */
export type FkExemption =
  | { readonly key: string; readonly reason: string }
  | { readonly references: string; readonly reason: string };

export const FK_EXEMPTIONS: readonly FkExemption[] = [
  {
    references: "actors",
    reason:
      "No operation deletes an actor: an actor is the identity audit rows, snapshots and proposals are attributed to, and deleting a user keeps it. The RI lookup on these columns never runs outside test fixtures, so ~100 indexes would cost every insert for nothing (#1291 decision).",
  },
  ...[
    "cms_admin site_defaults(default_template_id) -> templates",
    "cms_admin site_defaults(default_layout_id) -> layouts",
    "cms_admin site_defaults(default_page_type_id) -> page_types",
    "cms_admin site_defaults(home_page_id) -> pages",
    "cms_admin site_defaults(not_found_page_id) -> pages",
  ].map((key) => ({
    key,
    reason:
      "site_defaults holds exactly one row (singleton table); the RI check on a parent delete reads that one row with or without an index.",
  })),
];

/**
 * FKs without a usable index that issue #1291 (core indexes) decides: index
 * the ones whose parent is hard-deleted or garbage-collected, exempt the
 * rest with a reason. FIXME(issue #1291): this list goes away with it —
 * every entry the fix indexes turns stale and fails the lint until removed.
 */
export const FK_PENDING: readonly { readonly key: string; readonly issue: 1291 }[] = [
  "cms_admin role_permissions(permission_id) -> permissions",
  "cms_admin user_roles(role_id) -> roles",
  "cms_admin role_pending_actions(applied_role_id) -> roles",
  "cms_admin role_pending_actions(role_id) -> roles",
  "cms_admin sessions(user_id) -> users",
  "cms_admin owner_bootstrap_tokens(used_by) -> users",
  "cms_admin user_pending_actions(applied_user_id) -> users",
  "cms_admin user_pending_actions(user_id) -> users",
  "cms_admin layout_modules(module_id) -> modules",
  "cms_admin content_instances(module_id) -> modules",
  "cms_admin chat_sessions(template_id) -> templates",
  "cms_admin template_pending_actions(template_id) -> templates",
  "cms_admin pages(parent_page_id) -> pages",
  "cms_admin chat_sessions(page_id) -> pages",
  "cms_admin static_bakes(page_id) -> pages",
  "cms_admin import_pages(accepted_page_id) -> pages",
  "cms_admin quality_acceptances(page_id) -> pages",
  "cms_admin plugin_data_stale_pages(page_id) -> pages",
  "cms_admin site_snapshots(revert_of) -> site_snapshots",
  "cms_admin deploy_runs(site_snapshot_id) -> site_snapshots",
  "cms_admin chat_branch_publish_marks(site_snapshot_id) -> site_snapshots",
  "cms_admin snapshot_revert_pending_actions(applied_snapshot_id) -> site_snapshots",
  "cms_admin snapshot_revert_pending_actions(snapshot_id) -> site_snapshots",
  "cms_admin link_migration_runs(site_snapshot_id) -> site_snapshots",
  "cms_admin chat_sessions(parent_chat_session_id) -> chat_sessions",
  "cms_admin ai_calls(chat_session_id) -> chat_sessions",
  "cms_admin ai_calls(parent_chat_session_id) -> chat_sessions",
  "cms_admin site_memory_proposals(chat_session_id) -> chat_sessions",
  "cms_admin skill_proposals(chat_session_id) -> chat_sessions",
  "cms_admin subagent_runs(subagent_chat_session_id) -> chat_sessions",
  "cms_admin plugin_rate_limit_proposals(chat_session_id) -> chat_sessions",
  "cms_admin import_runs(chat_session_id) -> chat_sessions",
  "cms_admin deploy_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin layout_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin user_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin role_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin snapshot_revert_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin email_config_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin ai_providers_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin mcp_token_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin template_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin domain_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin tool_approval_actions(chat_session_id) -> chat_sessions",
  "cms_admin theme_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin page_edit_log(chat_session_id) -> chat_sessions",
  "cms_admin image_requests(chat_session_id) -> chat_sessions",
  "cms_admin owner_settings_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin site_defaults_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin quality_pending_actions(chat_session_id) -> chat_sessions",
  "cms_admin chat_lock_takeovers(from_chat_session_id) -> chat_sessions",
  "cms_admin chat_lock_takeovers(to_chat_session_id) -> chat_sessions",
  "cms_admin subagent_runs(parent_message_id) -> chat_messages",
  "cms_admin ai_calls(parent_ai_call_id) -> ai_calls",
  "cms_admin image_requests(call_id) -> ai_calls",
  "cms_admin deploy_runs(base_run_id) -> deploy_runs",
  "cms_admin deploy_pending_actions(applied_run_id) -> deploy_runs",
  "cms_admin plugin_data_stale_pages(last_run_id) -> deploy_runs",
  "cms_admin deploy_leases(holder_run_id) -> deploy_runs",
  "cms_admin templates(layout_id) -> layouts",
  "cms_admin layout_pending_actions(applied_layout_id) -> layouts",
  "cms_admin layout_pending_actions(layout_id) -> layouts",
  "cms_admin media_assets(derived_from_id) -> media_assets",
  "cms_admin pages_seo(og_image_asset_id) -> media_assets",
  "cms_admin themes(favicon_media_id) -> media_assets",
  "cms_admin themes(logo_dark_media_id) -> media_assets",
  "cms_admin themes(logo_media_id) -> media_assets",
  "cms_admin themes(social_share_media_id) -> media_assets",
  "cms_admin genesis_drafts(reference_asset_id) -> media_assets",
  "cms_admin image_requests(output_media_id) -> media_assets",
  "cms_admin skill_proposals(resulting_skill_id) -> skills",
  "cms_admin skill_pin_defaults(skill_id) -> skills",
  "cms_admin ai_calls(plugin_id) -> plugins",
  "cms_admin skills(plugin_id) -> plugins",
  "cms_admin plugin_pending_actions(plugin_id) -> plugins",
  "cms_admin image_requests(plugin_id) -> plugins",
  "cms_admin plugin_errors(plugin_id) -> plugins",
  "cms_admin list_types(plugin_id) -> plugins",
  "cms_admin change_consumers(plugin_id) -> plugins",
  "cms_admin plugin_rate_limit_overrides(profile_name) -> rate_limit_profiles",
  "cms_admin domain_pending_actions(applied_domain_id) -> domains",
  "cms_admin domain_pending_actions(domain_id) -> domains",
  "cms_admin mcp_token_pending_actions(applied_token_id) -> mcp_tokens",
  "cms_admin mcp_token_pending_actions(token_id) -> mcp_tokens",
  "cms_admin chat_agent_runs(mcp_token_id) -> mcp_tokens",
  "cms_admin chat_turn_approvals(mcp_token_id) -> mcp_tokens",
  "cms_admin theme_pending_actions(applied_theme_id) -> themes",
  "cms_admin theme_pending_actions(theme_id) -> themes",
  "cms_admin plugin_errors(bug_report_id) -> ai_bug_reports",
  "cms_admin plugin_capability_grants(plugin_id,artifact_digest) -> plugin_installation_versions",
  "cms_admin quality_audit_runs(retry_of) -> quality_audit_runs",
  "cms_admin quality_baselines(updated_by_run) -> quality_audit_runs",
  "cms_admin quality_acceptances(audit_run_id) -> quality_audit_runs",
  "cms_admin quality_pending_actions(audit_run_id) -> quality_audit_runs",
  "cms_admin chat_agent_runs(parent_run_id) -> chat_agent_runs",
  "cms_admin platform_update_notifications(request_id) -> platform_update_requests",
  "cms_admin chat_agent_runs(mcp_remote_connection_id) -> mcp_remote_connections",
  "cms_admin chat_turn_approvals(mcp_remote_connection_id) -> mcp_remote_connections",
  "cms_admin plugin_runtime(error_id) -> plugin_errors",
  "cms_admin lists(list_type_id) -> list_types",
  "cms_admin pages(page_type_id) -> page_types",
].map((key) => ({ key, issue: 1291 as const }));

/**
 * The catalog query: every FK outside the system and plugin schemas that no
 * valid, non-partial index serves — one whose first `n` key columns are the
 * FK's `n` columns, in any order.
 */
export const UNINDEXED_FOREIGN_KEYS_SQL = `
  SELECT c.conrelid::regclass::text AS "table",
         (SELECT string_agg(a.attname, ',' ORDER BY k.n)
            FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
         c.confrelid::regclass::text AS "references"
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace ns ON ns.oid = r.relnamespace
  WHERE c.contype = 'f'
    AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
    AND ns.nspname NOT LIKE 'plugin\\_%'
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
  ORDER BY 1, 2`;

/** The lint's verdict over the unindexed FKs of both databases. */
export interface FkLintVerdict {
  /** FKs neither list explains. */
  readonly unexplained: readonly string[];
  /** List entries that matched no unindexed FK (indexed now, or gone). */
  readonly stale: readonly string[];
}

/** Judge the unindexed FKs against {@link FK_EXEMPTIONS} and {@link FK_PENDING}. */
export function judgeForeignKeys(
  unindexed: readonly ForeignKeyRow[],
  exemptions: readonly FkExemption[] = FK_EXEMPTIONS,
  pending: readonly { readonly key: string }[] = FK_PENDING,
): FkLintVerdict {
  const used = new Set<object>();
  const unexplained: string[] = [];
  for (const fk of unindexed) {
    const key = fkKey(fk);
    const hit =
      exemptions.find((e) => ("key" in e ? e.key === key : e.references === fk.references)) ??
      pending.find((p) => p.key === key);
    if (hit) used.add(hit);
    else unexplained.push(key);
  }
  const stale = [...exemptions, ...pending]
    .filter((e) => !used.has(e))
    .map((e) => ("key" in e ? e.key : `every FK -> ${e.references}`));
  return { unexplained, stale };
}

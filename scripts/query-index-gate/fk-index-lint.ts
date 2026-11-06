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
 * look indexed in review and are not. The one exception is a predicate of
 * exactly `<fk> IS NOT NULL`, which the lookup's `<fk> = $1` implies.
 *
 * {@link FK_EXEMPTIONS} carries the reasoned exceptions (the decisions of
 * #1291: index every FK whose parent production hard-deletes, and what those
 * deletes cascade into; leave the rest). A stale entry fails the lint. Plugin schemas (`plugin_*`) are created at activation, not by the
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
    "cms_admin site_defaults(default_layout_id) -> layouts",
    "cms_admin site_defaults(home_page_id) -> pages",
    "cms_admin site_defaults(not_found_page_id) -> pages",
    "cms_admin site_defaults(pending_home_page_id) -> pages",
    "cms_admin site_defaults(pending_not_found_page_id) -> pages",
  ].map((key) => ({
    key,
    reason:
      "site_defaults holds exactly one row (singleton table); the RI check on a parent delete reads that one row with or without an index.",
  })),
  ...[
    "cms_admin static_bakes(page_id) -> pages",
    "cms_admin plugin_data_stale_pages(page_id) -> pages",
  ].map((key) => ({
    key,
    reason:
      "pages are soft-deleted; the bake tables' primary keys are (plugin_id, page_id) and every reader filters by plugin (#1291 decision).",
  })),
  ...[
    "cms_admin media_assets(derived_from_id) -> media_assets",
    "cms_admin pages_seo(og_image_asset_id) -> media_assets",
    "cms_admin themes(favicon_media_id) -> media_assets",
    "cms_admin themes(logo_dark_media_id) -> media_assets",
    "cms_admin themes(logo_media_id) -> media_assets",
    "cms_admin themes(social_share_media_id) -> media_assets",
    "cms_admin genesis_drafts(reference_asset_id) -> media_assets",
  ].map((key) => ({
    key,
    reason:
      "No production code hard-deletes a media asset (deletion is soft) and no reader filters on the column (#1291 decision).",
  })),
  ...[
    "cms_admin site_snapshots(revert_of) -> site_snapshots",
    "cms_admin deploy_runs(site_snapshot_id) -> site_snapshots",
    "cms_admin chat_branch_publish_marks(site_snapshot_id) -> site_snapshots",
    "cms_admin link_migration_runs(site_snapshot_id) -> site_snapshots",
    "cms_admin snapshot_revert_pending_actions(applied_snapshot_id) -> site_snapshots",
    "cms_admin snapshot_revert_pending_actions(snapshot_id) -> site_snapshots",
  ].map((key) => ({
    key,
    reason:
      "Site snapshots are history and never hard-deleted; no reader filters on the column (#1291 decision).",
  })),
  ...[
    "cms_admin deploy_runs(base_run_id) -> deploy_runs",
    "cms_admin deploy_pending_actions(applied_run_id) -> deploy_runs",
    "cms_admin plugin_data_stale_pages(last_run_id) -> deploy_runs",
    "cms_admin deploy_leases(holder_run_id) -> deploy_runs",
  ].map((key) => ({
    key,
    reason:
      "Deploy runs are history and never hard-deleted; deploy_leases holds one row per lease (#1291 decision).",
  })),
  ...[
    "cms_admin ai_calls(parent_ai_call_id) -> ai_calls",
    "cms_admin image_requests(call_id) -> ai_calls",
  ].map((key) => ({
    key,
    reason:
      "AI call rows are cost history and never hard-deleted on their own; no reader filters on the column (#1291 decision).",
  })),
  ...[
    "cms_admin quality_acceptances(audit_run_id) -> quality_audit_runs",
    "cms_admin quality_audit_runs(retry_of) -> quality_audit_runs",
    "cms_admin quality_baselines(updated_by_run) -> quality_audit_runs",
    "cms_admin quality_pending_actions(audit_run_id) -> quality_audit_runs",
    "cms_admin owner_bootstrap_tokens(used_by) -> users",
    "cms_admin user_pending_actions(applied_user_id) -> users",
    "cms_admin user_pending_actions(user_id) -> users",
    "cms_admin template_pending_actions(template_id) -> templates",
    "cms_admin templates(layout_id) -> layouts",
    "cms_admin layout_pending_actions(applied_layout_id) -> layouts",
    "cms_admin layout_pending_actions(layout_id) -> layouts",
    "cms_admin layout_modules(module_id) -> modules",
    "cms_admin skill_pin_defaults(skill_id) -> skills",
    "cms_admin skill_proposals(resulting_skill_id) -> skills",
    "cms_admin mcp_token_pending_actions(applied_token_id) -> mcp_tokens",
    "cms_admin mcp_token_pending_actions(token_id) -> mcp_tokens",
    "cms_admin chat_agent_runs(mcp_token_id) -> mcp_tokens",
    "cms_admin chat_turn_approvals(mcp_token_id) -> mcp_tokens",
    "cms_admin chat_agent_runs(mcp_remote_connection_id) -> mcp_remote_connections",
    "cms_admin chat_turn_approvals(mcp_remote_connection_id) -> mcp_remote_connections",
    "cms_admin platform_update_notifications(request_id) -> platform_update_requests",
    "cms_admin pages(page_type_id) -> page_types",
    "cms_admin lists(list_type_id) -> list_types",
    "cms_admin plugin_rate_limit_overrides(profile_name) -> rate_limit_profiles",
    "cms_admin plugin_errors(bug_report_id) -> ai_bug_reports",
    "cms_admin role_permissions(permission_id) -> permissions",
  ].map((key) => ({
    key,
    reason:
      "The parent is kept or soft-deleted, never hard-deleted by production code, and no reader filters on the column (#1291 decision; if the parent gains a hard delete, index it and add the parent to core-indexes.integration.test.ts's roots).",
  })),
];

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
      WHERE i.indrelid = c.conrelid AND i.indisvalid
        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
        AND (i.indpred IS NULL
             -- "WHERE fk IS NOT NULL" is implied by the RI lookup's
             -- "fk = $1" (a strict operator), so the planner uses it.
             OR (cardinality(c.conkey) = 1
                 AND pg_get_expr(i.indpred, i.indrelid) = format('(%I IS NOT NULL)',
                       (SELECT attname FROM pg_attribute
                         WHERE attrelid = c.conrelid AND attnum = c.conkey[1])))))
  ORDER BY 1, 2`;

/** The lint's verdict over the unindexed FKs of both databases. */
export interface FkLintVerdict {
  /** FKs no exemption explains. */
  readonly unexplained: readonly string[];
  /** List entries that matched no unindexed FK (indexed now, or gone). */
  readonly stale: readonly string[];
}

/** Judge the unindexed FKs against {@link FK_EXEMPTIONS}. */
export function judgeForeignKeys(
  unindexed: readonly ForeignKeyRow[],
  exemptions: readonly FkExemption[] = FK_EXEMPTIONS,
): FkLintVerdict {
  const used = new Set<object>();
  const unexplained: string[] = [];
  for (const fk of unindexed) {
    const key = fkKey(fk);
    const hit = exemptions.find((e) =>
      "key" in e ? e.key === key : e.references === fk.references,
    );
    if (hit) used.add(hit);
    else unexplained.push(key);
  }
  const stale = exemptions
    .filter((e) => !used.has(e))
    .map((e) => ("key" in e ? e.key : `every FK -> ${e.references}`));
  return { unexplained, stale };
}

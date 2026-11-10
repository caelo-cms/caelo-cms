// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — the query index gate's allowlist (docs/dev/query-index-gate.md).
 *
 * A finding is (op, relation, normalised filter) as analyze.ts prints it.
 * A rule matches by `table` (schema-qualified, `*` globs), optionally
 * narrowed by `op` (globs), the exact `filter` and the `kind`. Every rule
 * must match at least one finding of the run — a stale rule fails the gate,
 * so the list never outlives the code it describes.
 *
 * Each entry is a reasoned, permanent exemption — a singleton or fixed-size
 * table, a deliberate whole-table read, a maintenance scan, test-fixture SQL
 * run inside an adapter transaction. Pattern of `LICENSE_EXCEPTIONS` in
 * scripts/license-check.ts. Anything else gets an index.
 */

/** What an allowlist entry matches. */
export interface GateRule {
  /** Schema-qualified relation; `*` matches any run of characters. */
  readonly table: string;
  /** Operation / holder name; `*` globs. Omitted: any. */
  readonly op?: string;
  /** Exact normalised filter. Omitted: any. */
  readonly filter?: string;
  /** Omitted: both kinds. */
  readonly kind?: "filter" | "fk";
}

/** A permanent exemption and why the scan is fine. */
export interface AllowedRule extends GateRule {
  readonly reason: string;
}

/** Reason shared by the catalog-sized tables below. */
const FIXED_SIZE = (what: string) =>
  `${what} An index would not beat reading the few pages the table has, and every index costs each write.`;

/** Reason shared by test SQL that runs inside an adapter transaction (so it carries a tag). */
const FIXTURE = (what: string) =>
  `Test fixture SQL inside adapter.withAdminTransaction / withPublicTransaction (${what}); no operation runs this query.`;

export const ALLOWED: readonly AllowedRule[] = [
  {
    table: "public.ai_providers",
    op: "ai_providers.*",
    filter: "(is_active)",
    reason: FIXED_SIZE("One row per supported AI provider, four today."),
  },
  {
    table: "public.deploy_targets",
    reason: FIXED_SIZE("One row per environment (dev / staging / production)."),
  },
  {
    table: "public.site_defaults",
    op: "imports.*",
    filter: "((p.id = home_page_id) OR (p.id = pending_home_page_id))",
    reason: FIXED_SIZE(
      "site_defaults holds exactly one row (singleton table); the import lookups match a page against its home and pending home designations (#1497).",
    ),
  },
  {
    table: "public.genesis_drafts",
    reason: FIXED_SIZE(
      "The design-direction drafts of one Site Genesis run: a few variants per scope, replaced by the next run (#149).",
    ),
  },
  {
    table: "public.list_types",
    reason: FIXED_SIZE(
      "The list-type catalog: one row per kind of list (tens); list writes read the catalog whole to validate entries against it (#1107).",
    ),
  },
  {
    table: "public.page_types",
    reason: FIXED_SIZE("The page-type catalog: one row per page type (tens) (#1107)."),
  },
  {
    table: "public.users",
    op: "public_mail_deliveries.reserve_many",
    filter: "(lower(email) = ANY (?))",
    reason: FIXED_SIZE(
      "The admin's team (cms_admin users, a handful of rows), matched case-insensitively against staging mail recipients (#1337). lower() is not LEAKPROOF, so under the FORCEd RLS no expression index could serve it (docs/dev/rls-and-the-planner.md).",
    ),
  },
  {
    table: "public.layouts",
    reason: FIXED_SIZE("A site has a handful of layouts (site chrome)."),
  },
  {
    table: "public.layout_modules",
    reason: FIXED_SIZE(
      "The chrome placements of a site's handful of layouts; #1291 left layout_modules.module_id unindexed because modules are never hard-deleted.",
    ),
  },
  {
    table: "public.templates",
    reason: FIXED_SIZE("A site has a handful of templates."),
  },
  {
    table: "public.platform_update_requests",
    reason: FIXED_SIZE("One row per Caelo release install attempt: tens per year (#696)."),
  },
  {
    table: "public.plugins",
    reason: FIXED_SIZE("One row per installed plugin."),
  },
  {
    table: "public.plugin_installation_versions",
    reason: FIXED_SIZE("One row per submitted plugin version."),
  },
  {
    table: "public.published_projection_sections",
    reason:
      "cms_public side of the projection: one row per published section (tens); the publisher replaces the plugin sections wholesale.",
  },
  {
    table: "public.plugin_data_stale_pages",
    op: "deploy.finish_rollback",
    reason:
      "A rollback resets the bake mark of every stale page (#1155): a whole-table update by design, run once per rollback.",
  },
  {
    table: "public.redirects",
    op: "redirects.*",
    reason:
      "The operator/AI redirect search (ILIKE '%…%'). #1291 tried a pg_trgm GIN index: under the table's RLS policy ~~* is not leakproof, so it can never become an index condition for admin_role. Operator search, not a per-request path.",
  },
  {
    table: "public.font_assets",
    op: "fonts.find",
    reason:
      "Substring search over the family names of the site's acquired fonts (a few dozen): position(lower(q) in lower(family)) matches anywhere in the name, which no b-tree serves, and a trigram index cannot become an index condition under RLS (#1297). Operator/AI search, not a per-request path.",
  },
  {
    table: "plugin_*.*",
    op: "plugin_storage.list",
    filter: "(caelo_deleted_at IS NULL) AND (caelo_chat_branch_id IS NULL) AND (id <> ALL (?))",
    reason:
      "A plugin's unfiltered private list on a branch: every live row minus the rows the branch overlays (private-storage.ts privateListSql). A whole-table read the plugin asked for; the exclusion selects nearly every row.",
  },
  {
    table: "public.audit_events",
    op: "withAdminTransaction",
    filter: "(operation = ?)",
    reason: FIXTURE("assertions read audit rows by operation"),
  },
  {
    table: "public.audit_events",
    op: "rollback.count_mine",
    reason: FIXTURE("rollback.integration.test.ts's own test operation counts audit rows"),
  },
  {
    table: "public.modules",
    op: "withAdminTransaction",
    reason: FIXTURE("tests rewrite and delete their modules by slug or display name"),
  },
  {
    table: "public.theme_snapshots",
    op: "withAdminTransaction",
    reason: FIXTURE("a LIKE over the snapshot state"),
  },
  {
    table: "plugin_newsletter.send_runs",
    op: "withAdminTransaction",
    reason: FIXTURE("p12-plugins.integration.test.ts reads a campaign's send runs"),
  },
  {
    table: "plugin_ix*.*",
    op: "withPublicTransaction",
    reason: FIXTURE(
      "plugin-indexes-shipped.integration.test.ts (#1292) EXPLAINs reads on its ix<n> copies of the shipped plugins",
    ),
  },
];

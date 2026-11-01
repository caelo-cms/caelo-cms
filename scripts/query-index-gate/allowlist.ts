// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — the query index gate's lists (docs/dev/query-index-gate.md).
 *
 * A finding is (op, relation, normalised filter) as analyze.ts prints it.
 * A rule matches by `table` (schema-qualified, `*` globs), optionally
 * narrowed by `op` (globs), the exact `filter` and the `kind`. Every rule
 * must match at least one finding of the run — a stale rule fails the gate,
 * so the lists never outlive the code they describe.
 *
 *   - {@link ALLOWED}: reasoned, permanent exemptions — singleton or
 *     fixed-size tables, deliberate whole-table reads, maintenance scans.
 *     Pattern of `LICENSE_EXCEPTIONS` in scripts/license-check.ts.
 *   - {@link PENDING}: known findings a tracked issue fixes. Each one is a
 *     FIXME(issue #N): the fix's PR deletes the entries it makes stale.
 */

/** What a list entry matches. */
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

/** A known finding and the issue whose fix removes it. */
export interface PendingRule extends GateRule {
  readonly issue: 1291 | 1292;
}

/** Reason shared by the catalog-sized tables below. */
const FIXED_SIZE = (what: string) =>
  `${what} An index would not beat reading the few pages the table has, and every index costs each write.`;

export const ALLOWED: readonly AllowedRule[] = [
  {
    table: "public.deploy_targets",
    reason: FIXED_SIZE("One row per environment (dev / staging / production)."),
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
    table: "public.layouts",
    reason: FIXED_SIZE("A site has a handful of layouts (site chrome)."),
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
    table: "public.plugin_capability_grants",
    reason: FIXED_SIZE("The Owner's capability grants: a few per plugin version."),
  },
  {
    table: "public.public_projection_outbox",
    reason:
      "The projection outbox (#635) is drained after every commit; the publisher reads the whole pending queue by design, which holds only what the last commits enqueued.",
  },
  {
    table: "public.published_plugin_rows",
    reason:
      "cms_public side of the projection: the publisher replaces the published set wholesale, deleting every row not in the new set — a whole-table pass by design.",
  },
  {
    table: "public.published_projection_sections",
    reason:
      "cms_public side of the projection: one row per published section (tens); the publisher replaces the plugin sections wholesale.",
  },
  {
    table: "public.plugin_data_stale_pages",
    op: "deploy.release_rollback",
    reason:
      "A rollback resets the bake mark of every stale page (#1155): a whole-table update by design, run once per rollback.",
  },
  {
    table: "public.redirects",
    filter: "(status_code = ANY (?))",
    reason:
      "Link canonicalisation loads every permanent redirect (301/308 — nearly all of them) into memory; no index serves a filter that selects almost every row. Its cost is the redirect count, a scale question (#1003), not a missing index.",
  },
  {
    table: "public.modules",
    op: "withAdminTransaction",
    filter: "(slug = ?)",
    reason:
      "Test fixture SQL (font-reads.integration.test.ts rewrites a module's CSS by slug inside adapter.withAdminTransaction); no operation reads modules by slug including deleted rows.",
  },
  {
    table: "public.theme_snapshots",
    op: "withAdminTransaction",
    reason:
      "Test fixture SQL (a LIKE over the snapshot state inside adapter.withAdminTransaction); no operation searches theme snapshots by content.",
  },
];

/** Core findings #1291 (core indexes) fixes. FIXME(issue #1291). */
const CORE_PENDING: readonly string[] = [
  "public.ai_calls",
  "public.audit_events",
  "public.content_instances",
  "public.import_pages",
  "public.layout_modules",
  "public.quality_acceptances",
  "public.redirects",
  "public.role_pending_actions",
  "public.sessions",
];

/** Plugin tables #1292 (declared + automatic plugin indexes) fixes. FIXME(issue #1292). */
const PLUGIN_PENDING: readonly string[] = [
  "plugin_auth",
  "plugin_comments",
  "plugin_consent_manager",
  "plugin_external_private_notes",
  "plugin_forms",
  "plugin_international_site",
  "plugin_newsletter",
  "plugin_ratings",
  "plugin_t389_gamma",
  "plugin_t_pbs",
  "plugin_t_pbu",
  "plugin_test_p12_query_a",
];

export const PENDING: readonly PendingRule[] = [
  ...CORE_PENDING.map((table) => ({ table, issue: 1291 as const })),
  ...PLUGIN_PENDING.map((schema) => ({ table: `${schema}.*`, issue: 1292 as const })),
];

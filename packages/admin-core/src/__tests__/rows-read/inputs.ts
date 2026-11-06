// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — representative inputs for the rows-read test, per
 * `readScope: "request"` operation. An op enters the measured set by
 * adding its entry here, next to its integration test's fixtures; the
 * test holds it to O(request) from then on (rows-read.integration.test.ts).
 *
 * `ctx: "chat"` runs the call on the fixture's open chat (the shared
 * draft, with its pending history); `"system"` on main.
 */

import type { FixtureRefs } from "./fixture.js";

/** One measured call. */
export interface RowsReadInput {
  /**
   * Names the call when one op is measured in more than one shape (the
   * allowlists key on it); defaults to `op`.
   */
  readonly label?: string;
  readonly op: string;
  /**
   * Shipped plugins whose background paths (change consumer, cron, render
   * hook) make exactly this call — the plugin core-call guard (#1390)
   * holds them to this measurement.
   */
  readonly plugins?: readonly string[];
  readonly ctx: "system" | "chat";
  /**
   * The call's input. `tag` differs on every call, so a write changes
   * something each time (a write that changes nothing is a different code
   * path).
   */
  readonly input: (refs: FixtureRefs, tag: string) => unknown;
}

/** The key an input is measured and allowlisted under. */
export function inputKey(entry: RowsReadInput): string {
  return entry.label ?? entry.op;
}

export const ROWS_READ_INPUTS: readonly RowsReadInput[] = [
  // Single-entity reads: the editor and the AI read these on every turn.
  { op: "pages.get", ctx: "chat", input: (r) => ({ pageId: r.pageId }) },
  { op: "pages.get_with_modules", ctx: "chat", input: (r) => ({ pageId: r.pageId }) },
  {
    op: "pages_seo.get",
    ctx: "chat",
    plugins: ["international-site"],
    input: (r) => ({ pageId: r.pageId }),
  },
  { op: "modules.get", ctx: "chat", input: (r) => ({ moduleId: r.moduleId }) },
  {
    op: "content_instances.get",
    ctx: "chat",
    plugins: ["international-site"],
    input: (r) => ({ id: r.instanceId }),
  },
  // #1453 — international-site asks where the content it is about to write renders.
  {
    op: "content_instances.rendered_on_many",
    ctx: "system",
    plugins: ["international-site"],
    input: (r) => ({ ids: [r.instanceId] }),
  },
  // #1287 — international-site's translator reads every page through it;
  // its nested-content parents come from the reference index.
  {
    op: "page_module_content.list_for_page",
    ctx: "chat",
    plugins: ["international-site"],
    input: (r) => ({ pageId: r.pageId }),
  },
  { op: "lists.get", ctx: "chat", input: (r) => ({ id: r.listId }) },
  // #1323 — international-site reads the texts other plugins offer it.
  {
    op: "lists.plugin_source_texts",
    ctx: "system",
    plugins: ["international-site"],
    input: (r) => ({ pluginSlug: "international-site", pageId: r.pageId }),
  },
  { op: "media.get", ctx: "system", input: (r) => ({ assetId: r.mediaId }) },
  {
    op: "site_defaults.get",
    ctx: "system",
    plugins: ["international-site"],
    input: () => ({}),
  },
  // The Live Mode first paint and the changes pill.
  {
    op: "chat.list_pending_changes",
    ctx: "system",
    input: (r) => ({ chatSessionId: r.chatSessionId }),
  },
  {
    op: "chat.branch_change_count",
    ctx: "system",
    input: (r) => ({ chatSessionId: r.chatSessionId }),
  },
  {
    op: "chat.branch_edited_modules",
    ctx: "system",
    input: (r) => ({ chatSessionId: r.chatSessionId }),
  },
  { op: "chat.list_open_with_pending", ctx: "system", input: () => ({}) },
  // One page of the overview (the Changes page asks for its pages the same way).
  { op: "chat.list_open_changes", ctx: "system", input: () => ({ limit: 20 }) },
  // Unbounded list ops (#1269 makes them keyset-paginated).
  { op: "pages.list", ctx: "chat", input: () => ({}) },
  // #1269 — one page of the site, and the pages a plugin names
  // (international-site reads a page's variants and links by id).
  { op: "pages.list", label: "pages.list {limit}", ctx: "chat", input: () => ({ limit: 50 }) },
  {
    op: "pages.list",
    label: "pages.list {pageIds}",
    ctx: "chat",
    plugins: ["international-site"],
    input: (r) => ({ pageIds: [r.pageId] }),
  },
  // #1269 — the editor's page search: the fixture's one "Zebrafinch"
  // page, typed as far as an editor would. It reads its matches, not the
  // site.
  {
    op: "pages.search",
    label: "pages.search {query}",
    ctx: "chat",
    input: () => ({ query: "zebrafinch lan", limit: 50 }),
  },
  { op: "modules.list", ctx: "chat", input: () => ({}) },
  // #1424 — the module sits on every page and on every pending layout of
  // the fixture: the read stays at the cap on either size.
  { op: "modules.list_usage", ctx: "chat", input: (r) => ({ moduleIds: [r.moduleId] }) },
  { op: "snapshots.module_impact", ctx: "chat", input: (r) => ({ moduleId: r.moduleId }) },
  { op: "content_instances.list", ctx: "chat", input: () => ({}) },
  // The shapes plugins call in the background, after every write: the
  // consent-manager's change consumer re-reads the instances of what a
  // write touched (2026-11-03: these read the draft's whole pending
  // history and passed the statement timeout on production).
  {
    label: "content_instances.list {ids}",
    op: "content_instances.list",
    ctx: "chat",
    plugins: ["consent-manager"],
    input: (r) => ({ ids: [r.instanceId] }),
  },
  {
    label: "modules.list {moduleIds}",
    op: "modules.list",
    ctx: "chat",
    plugins: ["consent-manager"],
    input: (r) => ({ moduleIds: [r.write.moduleId] }),
  },
  {
    label: "content_instances.list {moduleIds}",
    op: "content_instances.list",
    ctx: "chat",
    plugins: ["consent-manager"],
    input: (r) => ({ moduleIds: [r.write.moduleId] }),
  },
  { op: "lists.list", ctx: "chat", input: () => ({}) },
  // international-site's render hooks and translation ops read the definitions only.
  { op: "list_types.list", ctx: "chat", plugins: ["international-site"], input: () => ({}) },
  { op: "page_types.list", ctx: "chat", plugins: ["international-site"], input: () => ({}) },
  // The counted shapes (EXACT_COUNTS): the admin pages and the AI's list tools.
  {
    op: "list_types.list",
    label: "list_types.list {counts}",
    ctx: "chat",
    input: () => ({ counts: true }),
  },
  {
    op: "page_types.list",
    label: "page_types.list {counts}",
    ctx: "chat",
    input: () => ({ counts: true }),
  },
  { op: "redirects.list", ctx: "system", input: () => ({}) },
  // Writes an agent makes one page at a time (translation-shaped work).
  {
    op: "modules.update",
    ctx: "chat",
    input: (r, tag) => ({ moduleId: r.write.moduleId, displayName: `Write target (${tag})` }),
  },
  {
    op: "content_instances.set_values",
    ctx: "chat",
    input: (r, tag) => ({ id: r.write.instanceId, values: { heading: `Heading (${tag})` } }),
  },
  // #1269 — international-site refreshes a page's path after every variant
  // write: the page's subtree and ancestors, not the page tree.
  {
    op: "pages.refresh_current_path",
    ctx: "system",
    plugins: ["international-site"],
    input: (r) => ({ pageId: r.pageId }),
  },
  {
    op: "pages.update",
    ctx: "chat",
    input: (r, tag) => ({ pageId: r.write.pageId, title: `Write target (${tag})` }),
  },
];

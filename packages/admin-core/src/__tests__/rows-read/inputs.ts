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
  { op: "content_instances.get", ctx: "chat", input: (r) => ({ id: r.instanceId }) },
  // #1287 — international-site's translator reads every page through it;
  // its nested-content parents come from the reference index.
  {
    op: "page_module_content.list_for_page",
    ctx: "chat",
    input: (r) => ({ pageId: r.pageId }),
  },
  { op: "lists.get", ctx: "chat", input: (r) => ({ id: r.listId }) },
  { op: "media.get", ctx: "system", input: (r) => ({ assetId: r.mediaId }) },
  { op: "site_defaults.get", ctx: "system", input: () => ({}) },
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
  { op: "modules.list", ctx: "chat", input: () => ({}) },
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
  { op: "list_types.list", ctx: "chat", input: () => ({}) },
  { op: "page_types.list", ctx: "chat", input: () => ({}) },
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
  {
    op: "pages.update",
    ctx: "chat",
    input: (r, tag) => ({ pageId: r.write.pageId, title: `Write target (${tag})` }),
  },
];

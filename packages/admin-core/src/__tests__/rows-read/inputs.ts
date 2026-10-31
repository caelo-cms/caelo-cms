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
  readonly op: string;
  readonly ctx: "system" | "chat";
  /**
   * The call's input. `tag` differs on every call, so a write changes
   * something each time (a write that changes nothing is a different code
   * path).
   */
  readonly input: (refs: FixtureRefs, tag: string) => unknown;
}

export const ROWS_READ_INPUTS: readonly RowsReadInput[] = [
  // Single-entity reads: the editor and the AI read these on every turn.
  { op: "pages.get", ctx: "chat", input: (r) => ({ pageId: r.pageId }) },
  { op: "pages.get_with_modules", ctx: "chat", input: (r) => ({ pageId: r.pageId }) },
  { op: "pages_seo.get", ctx: "chat", input: (r) => ({ pageId: r.pageId }) },
  { op: "modules.get", ctx: "chat", input: (r) => ({ moduleId: r.moduleId }) },
  { op: "content_instances.get", ctx: "chat", input: (r) => ({ id: r.instanceId }) },
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

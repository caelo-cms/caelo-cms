// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the rows-read test's allowlist, shared with the plugin
 * core-call guard (#1390), which must know which measured call shapes do
 * not meet the bar yet.
 */

/**
 * Ops that do not stay O(request) yet, and the issue that fixes each
 * (`FIXME(#n)`). Shrinks to empty; never grows without a tracked issue.
 */
export const ALLOWLIST: Readonly<Record<string, string>> = {
  // Unbounded list ops (#1269: required paging) and site-wide counts.
  "pages.list": "FIXME(#1269) unbounded, one bind parameter per page",
  "content_instances.list": "FIXME(#1269) unbounded",
  "lists.list": "FIXME(#1269) unbounded: one row and its usage per list",
};

/**
 * Call shapes that count on purpose (decision 2026-11-04, #1269): an exact
 * number the caller shows, counted by Postgres. They must still issue the
 * same statements and return the same rows on the larger site — one row
 * per type or chat, never the counted rows — only the buffers Postgres
 * reads to count may grow. Each names who asks for the number.
 */
export const EXACT_COUNTS: Readonly<Record<string, string>> = {
  "page_types.list {counts}":
    "pages per type; asked by the page-type admin pages and list_page_types",
  "list_types.list {counts}":
    "shared lists per type; asked by the list-type admin page and list_list_types",
  "chat.list_open_with_pending":
    "pending changes of each listed chat; the editor's other-chats banner shows them",
};

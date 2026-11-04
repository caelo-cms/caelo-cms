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
  // Visible since the fixture writes pending content history (#1390): the
  // open-chats summary counts every open chat's pending entities.
  "chat.list_open_with_pending": "FIXME(#1269) counts every open chat's pending entities",
  "lists.list": "FIXME(#1269) unbounded: one row and its usage per list",
  "list_types.list": "FIXME(#1269) usage counts over every list",
  "page_types.list": "FIXME(#1269) page counts over every page",
};

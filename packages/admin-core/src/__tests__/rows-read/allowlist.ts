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
  // Reads the whole site: link humanising, page tree, unbounded lists.
  "pages.list": "FIXME(#1269) unbounded, one bind parameter per page",
  "content_instances.list": "FIXME(#1269) unbounded",
  // Visible since the fixture writes pending content history (#1390): the
  // open-chats summary counts every open chat's pending entities.
  "chat.list_open_with_pending": "FIXME(#1269) counts every open chat's pending entities",
  "lists.list": "FIXME(#1269) usage of every list over every module and instance",
  "lists.get": "FIXME(#1269) link humanising reads every page and medium",
  "list_types.list": "FIXME(#1269) usage counts over every list",
  "page_types.list": "FIXME(#1269) page counts over every page",
  "site_defaults.get": "FIXME(#1269) reads every page to describe the defaults",
  "content_instances.get": "FIXME(#1269) reach reads every module default and shared list",
  "content_instances.set_values":
    "FIXME(#1269) reach reads every module default and shared list; link canonicalising every page",
};

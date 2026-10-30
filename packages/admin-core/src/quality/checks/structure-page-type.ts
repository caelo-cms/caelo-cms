// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1276 — `structure/unconfirmed-page-type` (warning): pages whose
 * page type nobody chose.
 *
 * Until #1276 a page created without a type landed on the stored default
 * type, a catch-all: page queries, overview pages and the page-type checks
 * saw it as a member of a kind of content it may not be. Migration 0443
 * marked exactly those pages (`pages.page_type_confirmed = false`); every
 * create path now requires the choice, and any write naming `pageType`
 * confirms. This rule reports the rest, ONE site-wide finding with the
 * paths and the types to choose from, fixable in one update_pages_many.
 *
 * A warning, never a block (maintainer decision on #1276: making it block
 * Publish live is a later step).
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { Finding } from "./findings.js";
import type { StructurePageIndex } from "./structure-listing.js";

/** Most page paths / types the message names before "…". */
const MAX_NAMED = 8;

/** The unconfirmed-page-type finding of the site, or none. Pure. */
export function unconfirmedPageTypeFindings(index: StructurePageIndex): Finding[] {
  const pages = [...index.pages.values()]
    .filter((p) => !p.pageTypeConfirmed)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (pages.length === 0) return [];
  const slugOf = (id: string) => index.pageTypes.get(id)?.slug ?? id;
  const named = pages
    .slice(0, MAX_NAMED)
    .map((p) => `${p.path} (now ${slugOf(p.pageTypeId)})`)
    .join(", ");
  const morePages = pages.length > MAX_NAMED ? ` … (+${pages.length - MAX_NAMED})` : "";
  const types = [...index.pageTypes.values()];
  const typeList = types
    .slice(0, MAX_NAMED)
    .map((t) => `${t.slug} (${t.purpose.replace(/\s+/g, " ").slice(0, 60)})`)
    .join(", ");
  const moreTypes = types.length > MAX_NAMED ? ` … (+${types.length - MAX_NAMED})` : "";
  const message = `Page type never chosen: ${pages.length} page(s) sit on a page type nobody picked for them — ${named}${morePages}. Page queries and overview pages count them as that kind of content. Types: ${typeList}${moreTypes}.`;
  return [
    {
      ruleId: "structure/unconfirmed-page-type",
      severity: "warning",
      message: truncateKeepingIds(message, 1000),
      fix: {
        tool: "update_pages_many",
        hint: "ONE update_pages_many naming each page's pageType (the current one too when it fits — naming it confirms it); a missing kind of page -> create_template with newPageType first",
      },
    },
  ];
}

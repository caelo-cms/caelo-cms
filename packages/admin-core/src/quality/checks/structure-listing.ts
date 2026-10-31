// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1256 — `structure/manual-page-listing`: an overview of pages kept
 * as hand-written cards or links instead of a list field bound to a page
 * query.
 *
 * A guides hub with one card per guide goes stale with the next guide:
 * every new page must be added by hand, one is forgotten, and the listing
 * cannot page. The data to build it already exists — page types, and the
 * `{kind:"query"}` / `term_pages` / `children` sources (docs/lists.md §6).
 *
 * Maintainer decision on #1256:
 * - per outermost module root, the links the page keeps by hand
 *   (structure-listing-links.ts) are grouped by the page type of their
 *   targets;
 * - a group is a listing when it links at least {@link MIN_LISTING_LINKS}
 *   pages of one type AND at least {@link MIN_LISTING_COVERAGE} of that
 *   type's published pages — a curated "top 3 of 40" stays allowed;
 * - only COLLECTION page types count (maintainer decision 2026-10-30,
 *   `PageTypeDef.collection`): a footer linking About, Team and Contact
 *   (standalone `content` pages) is navigation, not a listing;
 * - pages whose page type nobody chose are exempt (#1276: they sat on the
 *   old stored default type, which held the ordinary pages; links to them
 *   are ordinary link groups until someone gives them a type);
 * - error while pages of the type are missing (the message names them),
 *   warning when the set is complete (correct today, hand-maintained);
 * - deliberate exceptions go through the per-rule acceptance.
 *
 * "Published pages" are the pages of the staged build (the 404 page
 * aside), without the linking page itself: a hub of the same type does
 * not list itself.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import { pathKey } from "./links-analysis.js";
import type { StructureModule } from "./structure-analysis.js";
import { type ListingLinkGroup, MIN_LISTING_LINKS } from "./structure-listing-links.js";

export { MIN_LISTING_LINKS };

/** Share of a type's published pages a hand-kept group must link to be a listing. */
export const MIN_LISTING_COVERAGE = 0.5;
/** Most missing pages a message names before "…". */
const MAX_NAMED = 6;

/** Page types and pages as the listing rule needs them (main = staged). */
export interface StructurePageIndex {
  /** Page type id → slug, display name, purpose and whether it is a collection. */
  readonly pageTypes: ReadonlyMap<
    string,
    {
      readonly slug: string;
      readonly name: string;
      readonly purpose: string;
      readonly collection: boolean;
    }
  >;
  /**
   * Page id → its page type, whether that type was chosen (#1276; an
   * unchosen type is exempt, see the file header), title and path.
   */
  readonly pages: ReadonlyMap<
    string,
    {
      readonly pageTypeId: string;
      readonly pageTypeConfirmed: boolean;
      readonly title: string;
      readonly path: string;
    }
  >;
  /**
   * Hosts that are the site besides the staged origin (`host[:port]`):
   * the SEO base URL and public domains, plus the staged build's display
   * origin — a card linking `https://www.example.com/guides/x` links a
   * page of the site.
   */
  readonly siteHosts: ReadonlySet<string>;
}

/** One listing seen on one or more pages (the same module, type and gap). */
interface Listing {
  readonly moduleId: string;
  readonly pageTypeId: string;
  readonly missing: readonly string[];
  readonly pageIds: Set<string>;
  linked: number;
  total: number;
}

/** The manual-page-listing findings of one staged build. Pure. */
export function manualListingFindings(
  groups: readonly ListingLinkGroup[],
  pages: readonly StagedPage[],
  index: StructurePageIndex,
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  if (groups.length === 0) return [];
  const live = pages.filter((p) => !p.notFoundPage);
  const hosts = new Set(index.siteHosts);
  const pageByKey = new Map<string, string>();
  for (const p of live) {
    try {
      const url = new URL(p.url);
      hosts.add(url.host.toLowerCase());
      pageByKey.set(pathKey(url.pathname), p.pageId);
    } catch {
      // A page without a parsable URL is no link target.
    }
  }
  const pageOf = (target: string): string | undefined => {
    const url = new URL(target);
    return hosts.has(url.host) ? pageByKey.get(pathKey(url.pathname)) : undefined;
  };
  const pagesOfType = new Map<string, string[]>();
  for (const p of live) {
    const indexed = index.pages.get(p.pageId);
    // A staged page the index does not know was deleted after the build
    // was staged; it is no member of any type now.
    if (indexed === undefined || !indexed.pageTypeConfirmed) continue;
    const typeId = indexed.pageTypeId;
    pagesOfType.set(typeId, [...(pagesOfType.get(typeId) ?? []), p.pageId]);
  }

  const listings = new Map<string, Listing>();
  for (const g of groups) {
    const linkedByType = new Map<string, Set<string>>();
    for (const t of g.targets) {
      const target = pageOf(t);
      if (target === undefined || target === g.pageId) continue;
      const indexed = index.pages.get(target);
      if (indexed === undefined || !indexed.pageTypeConfirmed) continue;
      const typeId = indexed.pageTypeId;
      const set = linkedByType.get(typeId) ?? new Set<string>();
      set.add(target);
      linkedByType.set(typeId, set);
    }
    for (const [typeId, linked] of linkedByType) {
      if (index.pageTypes.get(typeId)?.collection !== true) continue;
      if (linked.size < MIN_LISTING_LINKS) continue;
      const all = (pagesOfType.get(typeId) ?? []).filter((id) => id !== g.pageId);
      if (linked.size < MIN_LISTING_COVERAGE * all.length) continue;
      const missing = all.filter((id) => !linked.has(id)).sort();
      const key = `${g.moduleId}\u0000${typeId}\u0000${missing.join(",")}`;
      const l = listings.get(key) ?? {
        moduleId: g.moduleId,
        pageTypeId: typeId,
        missing,
        pageIds: new Set<string>(),
        linked: 0,
        total: 0,
      };
      l.pageIds.add(g.pageId);
      if (linked.size > l.linked) {
        l.linked = linked.size;
        l.total = all.length;
      }
      listings.set(key, l);
    }
  }
  return [...listings.values()].map((l) => listingFinding(l, live, index, byId));
}

function listingFinding(
  l: Listing,
  pages: readonly StagedPage[],
  index: StructurePageIndex,
  byId: ReadonlyMap<string, StructureModule>,
): Finding {
  const type = index.pageTypes.get(l.pageTypeId);
  const slug = type?.slug ?? l.pageTypeId;
  const typeName = `"${type?.name ?? slug}" (${slug})`;
  const module = byId.get(l.moduleId)?.displayName ?? l.moduleId;
  const pathOf = new Map(pages.map((p) => [p.pageId, p.path]));
  const where = l.pageIds.size === 1 ? "" : ` on ${l.pageIds.size} pages`;
  const complete = l.missing.length === 0;
  const named = l.missing
    .slice(0, MAX_NAMED)
    .map((id) => `"${index.pages.get(id)?.title ?? id}" (${pathOf.get(id) ?? id})`);
  const more = l.missing.length > MAX_NAMED ? ` … (+${l.missing.length - MAX_NAMED})` : "";
  const message = complete
    ? `Manual page listing: "${module}" (${l.moduleId})${where} links all ${l.linked} published pages of type ${typeName} as hand-kept cards or links — complete today, but every new ${slug} page has to be added by hand.`
    : `Manual page listing: "${module}" (${l.moduleId})${where} links ${l.linked} of ${l.total} published pages of type ${typeName} as hand-kept cards or links — missing ${named.join(", ")}${more}. Every new ${slug} page has to be added by hand and gets forgotten.`;
  const pageId = l.pageIds.size === 1 ? [...l.pageIds][0] : undefined;
  return {
    ruleId: "structure/manual-page-listing",
    severity: complete ? "warning" : "error",
    ...(pageId ? { pageId } : {}),
    message: truncateKeepingIds(message, 1000),
    fix: {
      tool: "update_modules_many",
      hint: `replace the hand-kept cards with ONE \`list\` field bound to a page query — {kind:"list", bind:"source", source:{kind:"query", defaults:{page_type:"${slug}"}}} (term_pages for a category, children for sub-pages), rendered with {{#field}}…{{link}}…{{title}}…{{/field}}; check it with preview_list_source, then remove the stored cards from the page`,
    },
  };
}

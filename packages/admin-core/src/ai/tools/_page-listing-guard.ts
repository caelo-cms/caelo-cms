// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1256 — write-time hint for an overview of pages kept by hand: the
 * early half of the structure check's `structure/manual-page-listing`
 * (quality/checks/structure-listing.ts).
 *
 * The moment the AI writes cards that link most pages of one page type
 * (a guides hub with one card per guide) is the moment to say: this is a
 * page query, not cards. A warning on an already-successful write, never
 * a gate — the quality check blocks Publish live while pages are missing.
 *
 * The written values are the tool input: internal links as the AI writes
 * them (`/guides/setup`) or as canonical references (`caelo:page/<id>`),
 * in link objects (`{href}`), list entries, scalar fields and hand-written
 * HTML. A shared-list binding (`caelo:list/<id>`) is no link. Cards placed
 * through references to existing content instances are not followed here;
 * the quality check sees them in the staged build.
 *
 * Same thresholds as the check: at least {@link MIN_LISTING_LINKS} links
 * to pages of one page type that cover at least
 * {@link MIN_LISTING_COVERAGE} of its published pages; pages whose page
 * type nobody chose (#1276) are exempt.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { pathKey } from "../../quality/checks/links-analysis.js";
import { MIN_LISTING_COVERAGE, MIN_LISTING_LINKS } from "../../quality/checks/structure-listing.js";
import type { ToolContext } from "./dispatch.js";

/** Values one listing is judged on: one page's worth of written values. */
export type ListingGroup = readonly Readonly<Record<string, unknown>>[];

/** A page as the hint needs it (pages.list, the caller's view). */
export interface ListingPage {
  readonly id: string;
  readonly currentPath: string;
  readonly title: string;
  readonly pageTypeId: string;
  /** #1276 — false while nobody chose the page type: exempt. */
  readonly pageTypeConfirmed: boolean;
  readonly status: "draft" | "published";
}

/** The site facts the hint compares against. */
export interface ListingSite {
  readonly pageTypes: ReadonlyMap<string, { readonly slug: string; readonly name: string }>;
  readonly pages: readonly ListingPage[];
}

/** Most missing pages a hint names. */
const MAX_NAMED = 5;

const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})(?:[?#].*)?$/i;
const HREF_ATTR_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** The link-like strings in written values (paths, page references, href attributes). */
export function writtenLinks(values: Readonly<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const s = raw.trim();
    if (PAGE_REF_RE.test(s) || (s.startsWith("/") && !s.startsWith("//") && !/\s/.test(s))) {
      out.add(s);
    }
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.includes("href")) {
        for (const m of v.matchAll(HREF_ATTR_RE)) add(m[1] ?? m[2] ?? "");
      } else add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v !== null && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  for (const v of Object.values(values)) walk(v);
  return [...out];
}

/** The written values grouped per page, for a tool that writes to several pages. */
export function listingGroupsByPage<I>(
  items: readonly I[],
  pageOf: (item: I) => string,
  valuesOf: (item: I) => Readonly<Record<string, unknown>>,
): ListingGroup[] {
  const byPage = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const item of items) {
    const page = pageOf(item);
    byPage.set(page, [...(byPage.get(page) ?? []), valuesOf(item)]);
  }
  return [...byPage.values()];
}

/** Whether any group writes enough links to be a listing (saves the site read). */
export function mayBeListing(groups: readonly ListingGroup[]): boolean {
  return groups.some((g) => new Set(g.flatMap(writtenLinks)).size >= MIN_LISTING_LINKS);
}

/** The hints for `groups` against the site (pure; exported for tests). */
export function pageListingHints(groups: readonly ListingGroup[], site: ListingSite): string[] {
  const byId = new Map(site.pages.map((p) => [p.id, p]));
  const byKey = new Map(site.pages.map((p) => [pathKey(p.currentPath), p]));
  const resolve = (link: string): ListingPage | undefined => {
    const ref = PAGE_REF_RE.exec(link);
    if (ref) return byId.get((ref[1] as string).toLowerCase());
    return byKey.get(pathKey(link.split(/[?#]/)[0] ?? link));
  };
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const linkedByType = new Map<string, Set<string>>();
    for (const link of new Set(group.flatMap(writtenLinks))) {
      const p = resolve(link);
      // Only published targets count, as in the quality check: a draft
      // is no member of the published set the coverage is measured against.
      if (p?.status !== "published" || !p.pageTypeConfirmed) continue;
      const set = linkedByType.get(p.pageTypeId) ?? new Set<string>();
      set.add(p.id);
      linkedByType.set(p.pageTypeId, set);
    }
    for (const [typeId, linked] of linkedByType) {
      if (linked.size < MIN_LISTING_LINKS) continue;
      const published = site.pages.filter(
        (p) => p.pageTypeId === typeId && p.status === "published",
      );
      if (linked.size < MIN_LISTING_COVERAGE * published.length) continue;
      const missing = published.filter((p) => !linked.has(p.id));
      const type = site.pageTypes.get(typeId);
      const slug = type?.slug ?? typeId;
      const key = `${typeId}\u0000${[...linked].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const gap =
        missing.length === 0
          ? `all ${published.length} published "${type?.name ?? slug}" pages`
          : `${linked.size} of ${published.length} published "${type?.name ?? slug}" pages, missing ${missing
              .slice(0, MAX_NAMED)
              .map((p) => `"${p.title}" (${p.currentPath})`)
              .join(
                ", ",
              )}${missing.length > MAX_NAMED ? ` … (+${missing.length - MAX_NAMED})` : ""}`;
      hints.push(
        `these values link ${gap} (page type \`${slug}\`) by hand — an overview kept as cards goes stale with the next ${slug} page: render it from ONE \`list\` field bound to a page query ({kind:"list", bind:"source", source:{kind:"query", defaults:{page_type:"${slug}"}}}; term_pages for a category, children for sub-pages) and drop the hand-kept cards; the structure quality check reports it (structure/manual-page-listing)`,
      );
    }
  }
  return hints;
}

/** The site facts in the caller's view; null on a failed read (the hint is lost, not the write). */
async function loadSite(ctx: ExecutionContext, toolCtx: ToolContext): Promise<ListingSite | null> {
  const run = (op: string, input: unknown) =>
    execute(toolCtx.registry, toolCtx.adapter, ctx, op, input);
  const [types, pages] = await Promise.all([
    run("page_types.list", {}),
    run("pages.list", { includeDeleted: false }),
  ]);
  if (!types.ok || !pages.ok) return null;
  const typeRows = (types.value as { pageTypes?: { id: string; slug: string; name: string }[] })
    .pageTypes;
  const pageRows = (pages.value as { pages?: ListingPage[] }).pages;
  // Without the rows there is nothing to compare against: the hint is
  // skipped, never guessed.
  if (!typeRows || !pageRows) return null;
  return {
    pageTypes: new Map(typeRows.map((t) => [t.id, { slug: t.slug, name: t.name }])),
    pages: pageRows,
  };
}

/** Suffix for a write ("" when there is nothing to say). */
export async function pageListingSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  groups: readonly ListingGroup[],
): Promise<string> {
  if (!mayBeListing(groups)) return "";
  const site = await loadSite(ctx, toolCtx);
  if (!site) return "";
  const hints = pageListingHints(groups, site);
  return hints.length === 0 ? "" : ` 🎯 page-listing: ${hints.join(". ")}.`;
}

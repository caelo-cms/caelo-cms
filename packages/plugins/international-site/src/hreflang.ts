// SPDX-License-Identifier: MPL-2.0

/**
 * Which language versions of a page take part in its hreflang set: the
 * one rule the head and sitemap contributions (`head_contributions` in
 * ./index.ts) and the Stage audit (`hreflang` in ./audit-rules.ts) share.
 *
 * hreflang annotates pages a search engine indexes: each alternate says
 * "show this address to readers of that language instead". A noindex page
 * is never shown, so it neither carries hreflang nor is named by it.
 * Pointing hreflang at a noindex page is what search engines discard and
 * SEO tools report ("noindex return links"). Some language versions are
 * noindex on purpose: site-search requires its results page (`/de/suche`,
 * `/en/search`) to be. Such a page stays a language version: it keeps its
 * language group, its place in the language switch and its variant links,
 * and only hreflang leaves it out.
 *
 * The set is therefore the indexable published versions, and only on an
 * indexable page. Fewer than two leave no alternates at all: a page with
 * no other indexable version has nothing to point at. x-default names the
 * default language's version when that one takes part and is absent
 * otherwise: another language in its place would be a choice the operator
 * never made.
 */

/** Is a `<meta name="robots">` content (lower-case) one that keeps the page out of the index? */
export function robotsNoindex(robots: string | null): boolean {
  if (robots === null) return false;
  return robots
    .split(",")
    .map((d) => d.trim())
    .some((d) => d === "noindex" || d === "none");
}

/**
 * The versions of `pageId`'s hreflang set: `versions` (every published
 * version of its group, itself included) without the noindex ones, or
 * none when the page itself is noindex or fewer than two remain.
 *
 * @param isNoindex whether a page of `versions`, or `pageId`, is noindex.
 */
export function hreflangSet<V extends { readonly pageId: string }>(
  pageId: string,
  versions: readonly V[],
  isNoindex: (pageId: string) => boolean,
): V[] {
  if (isNoindex(pageId)) return [];
  const indexable = versions.filter((v) => !isNoindex(v.pageId));
  return indexable.length >= 2 ? indexable : [];
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Slug/URL primitives shared between the static generator, the preview
 * op, and the admin UI (epic #380 #384 — successor of the deleted
 * i18n.ts). URL shape beyond base + slug becomes a plugin contribution
 * on the URL composition point (#390).
 *
 *   isHomeSlug / isDesignatedHomePage — the home-decision predicate.
 *   trimSlashes / trimTrailingSlashes — linear-scan slug hygiene.
 */

/**
 * Strip leading and trailing `/` characters with a single linear scan.
 *
 * Replaces the regex `/^\/+|\/+$/g`, whose trailing-slash branch
 * backtracks O(n²) on a long run of slashes that is not at end-of-string
 * (CodeQL js/polynomial-redos). This char-index walk is unconditionally
 * linear and produces byte-identical output for every input.
 */
export function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 47 /* '/' */) start += 1;
  while (end > start && s.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return s.slice(start, end);
}

/**
 * Strip only trailing `/` characters with a single linear scan — the
 * non-backtracking replacement for `/\/+$/` (same ReDoS class as above).
 * Used for base URLs, which carry a scheme and must keep their leading
 * characters.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return s.slice(0, end);
}

/**
 * The "magic slug" sentinel test: a page whose slug is empty, `home`,
 * or `index` is the site root by convention even without an explicit
 * `site_defaults.home_page_id` designation. Leading/trailing slashes
 * are ignored so `/home/` reads the same as `home`.
 */
export function isHomeSlug(slug: string): boolean {
  const s = trimSlashes(slug);
  return s === "" || s === "home" || s === "index";
}

/**
 * The single home-decision predicate every URL/output-path site must
 * use so canonical, redirects, and the emitted file agree (0184
 * explicit-homepage feature). A page is the site root when it IS the
 * designated `site_defaults.home_page_id` OR carries a magic slug.
 *
 * @param pageId              The page being resolved.
 * @param slug                That page's slug.
 * @param designatedHomePageId  `site_defaults.home_page_id`
 *                              (null/undefined when none designated).
 */
export function isDesignatedHomePage(
  pageId: string,
  slug: string,
  designatedHomePageId: string | null | undefined,
): boolean {
  return (designatedHomePageId != null && pageId === designatedHomePageId) || isHomeSlug(slug);
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Slug/URL primitives shared between the static generator, the preview
 * op, and the admin UI. Epic #380 Phase A (#383): locale URL shaping
 * (resolveLocaleUrl, buildHreflangLinks) is deleted — URL shape beyond
 * base + slug becomes a plugin contribution on the URL composition
 * point (#390). What survives until the page-identity cut (#384):
 *
 *   isHomeSlug / pageIsLocaleHome — the home-decision predicate.
 *   computeContentHash — drives `pages.content_hash` (removed in #384).
 *   trimSlashes / trimTrailingSlashes — linear-scan slug hygiene.
 */

const TEXT_ENCODER = new TextEncoder();

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
 * or `index` is the locale root by convention even without an explicit
 * `locales.home_page_id` designation. Leading/trailing slashes are
 * ignored so `/home/` reads the same as `home`.
 */
export function isHomeSlug(slug: string): boolean {
  const s = trimSlashes(slug);
  return s === "" || s === "home" || s === "index";
}

/**
 * The single home-decision predicate every URL/output-path site must
 * use so canonical, hreflang, redirects, and the emitted file agree
 * (0184 explicit-homepage feature). A page is the locale root when it
 * IS the locale's designated `home_page_id` OR carries a magic slug.
 *
 * @param pageId            The page being resolved.
 * @param slug              That page's slug.
 * @param localeHomePageId  `locales.home_page_id` for the page's locale
 *                          (null/undefined when no page is designated).
 */
export function pageIsLocaleHome(
  pageId: string,
  slug: string,
  localeHomePageId: string | null | undefined,
): boolean {
  return (localeHomePageId != null && pageId === localeHomePageId) || isHomeSlug(slug);
}

/**
 * Canonical-JSON serializer + sha256 → hex. Stable across runs because
 * keys are sorted. The output is used for `pages.content_hash` so that
 * a Mode-2 translation can detect whether its source has changed.
 */
export async function computeContentHash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) sorted[k] = (val as Record<string, unknown>)[k];
      return sorted;
    }
    return val;
  });
  const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

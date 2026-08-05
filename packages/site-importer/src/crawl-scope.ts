// SPDX-License-Identifier: MPL-2.0

/**
 * issue #425 — language/section scope for crawl + sampling.
 *
 * Dogfood 2026-08-04: migrating the German searchviu site, the crawl
 * stored the EN sample URL of a blog article whose German version lives
 * under /google-search-console-daten-nach-bigquery-exportieren/ —
 * discovered only via a live redirect at rebuild time. The operator asks
 * for ONE language/section of a source site; the crawler must honour
 * that, not improvise around it.
 *
 * A scope has two independent, combinable rules:
 *   - `pathPrefix` — a URL-path rule ("/de/"): URLs outside the prefix
 *     are recorded as skipped, never crawled. Cheap, decided pre-fetch.
 *   - `locale` — hreflang awareness for sites whose language sections
 *     don't share a prefix (searchviu's German lives at the root): a
 *     fetched page whose own hreflang alternates name a DIFFERENT URL as
 *     the scope-locale version is the wrong-language page — it is
 *     skipped and the named alternate crawled instead. This is a
 *     POSITIVE-signal-only rule: pages without a matching alternate are
 *     kept (partial/sloppy hreflang markup must never false-skip a
 *     genuinely in-scope page); the pathPrefix rule stays the hard
 *     filter.
 *
 * Pure URL/string logic only — the crawler owns the fetch loop.
 */

import type { HreflangAlternate } from "./page-facets.js";

/** The operator's language/section scope for a crawl or sampling pass. */
export interface CrawlScope {
  /** Path prefix in-scope URLs must live under, e.g. "/de/". Trailing
   *  slash optional ("/de" and "/de/" are the same rule); "/" scopes
   *  everything. */
  readonly pathPrefix?: string;
  /** Source-site language code ("de", "pt-br") matched against hreflang
   *  alternates the source markup exposes. */
  readonly locale?: string;
}

/** A URL the crawler declined with why — reported, never silent. */
export interface SkippedUrl {
  readonly url: string;
  readonly reason: string;
}

/** Cap on reported skipped entries — the COUNT stays exact beyond it. */
export const MAX_SKIPPED_REPORTED = 200;

/**
 * Normalise a URL for dedupe + comparison: drop the hash, collapse ALL
 * trailing slashes (`/a/`, `/a//`, `/a#top` → `/a`; the root collapses
 * to `/`), KEEP the query string (`?page=2` is a distinct page).
 * Same key shape LIST mode has always used, shared so requested/final
 * URL comparison and the frontier agree on identity.
 */
export function normalizeCrawlUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString();
}

/**
 * Is `pathname` inside the scope's `pathPrefix`? Prefix matching is
 * segment-aware — "/de" covers "/de" and "/de/…" but never "/design"
 * (no blind string-slice; see urlToSlug's run #9 regression for why).
 */
export function isPathInScope(pathname: string, pathPrefix: string): boolean {
  const prefix = pathPrefix.replace(/\/+$/, "");
  if (prefix === "") return true; // "/" scopes everything
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Does an hreflang code satisfy the scope locale? Case-insensitive;
 * a bare scope locale accepts regional variants ("de" matches "de" and
 * "de-AT"), while a regional scope locale requires the exact code.
 */
export function hreflangMatchesLocale(hreflang: string, locale: string): boolean {
  const h = hreflang.trim().toLowerCase();
  const l = locale.trim().toLowerCase();
  if (h === "x-default") return false;
  return h === l || h.startsWith(`${l}-`);
}

/**
 * Pick the scope locale's alternate URL from a page's hreflang set, or
 * null when the markup exposes none for that locale (= no signal — the
 * caller must NOT treat that as out-of-scope). An exact language-code
 * match wins over a regional variant.
 */
export function pickLocaleAlternate(
  alternates: readonly HreflangAlternate[],
  locale: string,
): string | null {
  const l = locale.trim().toLowerCase();
  let regional: string | null = null;
  for (const alt of alternates) {
    const h = alt.hreflang.trim().toLowerCase();
    if (h === l) return alt.href;
    if (regional === null && hreflangMatchesLocale(h, l)) regional = alt.href;
  }
  return regional;
}

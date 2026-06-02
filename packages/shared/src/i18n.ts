// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — i18n primitives shared between the static generator, the
 * preview op, and the admin UI:
 *
 *   computeContentHash(page, modules) — sha256 of canonical-JSON
 *     content. Drives `pages.content_hash` + the translation_status
 *     recompute path.
 *
 *   resolveLocaleUrl(locale, slug, defaultLocaleCode, siteBaseUrl) —
 *     builds the public URL for a (locale, slug) tuple given the
 *     locale's url_strategy + url_host. Used by:
 *       - hreflang emitter
 *       - sitemap.xml emitter (when extended for i18n)
 *       - language-selector module
 *
 *   buildHreflangLinks(currentLocale, perLocaleUrls, defaultLocaleCode) —
 *     emits the `<link rel="alternate" hreflang=...>` markup.
 *
 *   lintLocaleConfig(locales, advancedUrlRouting) — surfaces config
 *     warnings (mixed strategies, missing url_host for subdomain/
 *     domain, default locale using `none` alongside subdirectory
 *     siblings, advanced strategy chosen while toggle is off).
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

export interface LocaleConfig {
  code: string;
  displayName: string;
  urlStrategy: "none" | "subdirectory" | "subdomain" | "domain";
  urlHost: string | null;
  isDefault: boolean;
}

/**
 * Build a public-facing URL for a (locale, slug) tuple. Pure function —
 * no DB access — so the static generator can call it for every page
 * without round-trips.
 *
 * @param locale       The target locale's full config row.
 * @param slug         Path component (e.g. "about", "blog/post-1"). No leading slash.
 * @param siteBaseUrl  Default base URL when the strategy is `none` or
 *                     `subdirectory` (e.g. "https://example.com").
 * @returns Absolute URL, including scheme + host.
 */
export function resolveLocaleUrl(
  locale: LocaleConfig,
  slug: string,
  siteBaseUrl: string,
  // v0.2.85 — page emission style. 'directory' (default) builds
  // URLs ending in `/<slug>/`; 'no-extension' builds URLs ending
  // in `/<slug>` (no trailing slash) to match what the bucket
  // actually serves when pages are emitted as bare slugs. Home
  // page is always `<base>/` regardless of style.
  pageUrlStyle: "directory" | "no-extension" = "directory",
): string {
  const stripped = trimSlashes(slug);
  const isHome = stripped === "" || stripped === "home" || stripped === "index";
  // tail: the path component appended after `<base>/` or `<base>/<locale>/`.
  // 'directory' style: trailing slash for non-home so the URL points at
  // the directory the bucket serves index.html from.
  // 'no-extension' style: no trailing slash, no extension — the URL
  // points at the bare-slug object the bucket serves directly.
  const tail = isHome ? "" : pageUrlStyle === "no-extension" ? stripped : `${stripped}/`;
  const base = trimTrailingSlashes(siteBaseUrl);
  switch (locale.urlStrategy) {
    case "none":
      return tail ? `${base}/${tail}` : `${base}/`;
    case "subdirectory":
      // Default locale with strategy `subdirectory` still gets the prefix
      // unless the migration set strategy=none for it. The decision is
      // explicit per locale row, not implicit on isDefault.
      return tail ? `${base}/${locale.code}/${tail}` : `${base}/${locale.code}/`;
    case "subdomain": {
      if (!locale.urlHost) {
        throw new Error(
          `locale '${locale.code}' uses url_strategy='subdomain' without url_host — config invalid`,
        );
      }
      const protocol = base.startsWith("http://") ? "http://" : "https://";
      return tail ? `${protocol}${locale.urlHost}/${tail}` : `${protocol}${locale.urlHost}/`;
    }
    case "domain": {
      if (!locale.urlHost) {
        throw new Error(
          `locale '${locale.code}' uses url_strategy='domain' without url_host — config invalid`,
        );
      }
      const protocol = base.startsWith("http://") ? "http://" : "https://";
      return tail ? `${protocol}${locale.urlHost}/${tail}` : `${protocol}${locale.urlHost}/`;
    }
  }
}

/**
 * Emit `<link rel="alternate" hreflang="…">` tags for every locale
 * that has a published variant of this page. The default locale also
 * gets an `x-default` entry per Google's i18n guidance.
 *
 * Returned as a single string suitable for splicing into <head>.
 */
export function buildHreflangLinks(
  perLocaleUrls: ReadonlyArray<{ localeCode: string; url: string; isDefault: boolean }>,
): string {
  if (perLocaleUrls.length === 0) return "";
  const lines: string[] = [];
  for (const v of perLocaleUrls) {
    lines.push(
      `<link rel="alternate" hreflang="${escapeAttr(v.localeCode)}" href="${escapeAttr(v.url)}" />`,
    );
  }
  const def = perLocaleUrls.find((v) => v.isDefault);
  if (def) {
    lines.push(`<link rel="alternate" hreflang="x-default" href="${escapeAttr(def.url)}" />`);
  }
  return lines.join("\n");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

export interface LocaleLintWarning {
  code: string;
  message: string;
}

/**
 * Cross-row config sanity checks. Run at:
 *   - propose-time (warnings stored on the proposal preview)
 *   - render-time (no fail-loudly per CLAUDE.md §2 since the renderer
 *     can still emit; surfaced in admin UI as banners)
 */
export function lintLocaleConfig(
  locales: ReadonlyArray<LocaleConfig>,
  advancedUrlRouting: boolean,
): LocaleLintWarning[] {
  const warnings: LocaleLintWarning[] = [];
  const usingAdvanced = locales.some(
    (l) => l.urlStrategy === "subdomain" || l.urlStrategy === "domain",
  );
  if (usingAdvanced && !advancedUrlRouting) {
    warnings.push({
      code: "advanced-routing-disabled",
      message:
        "one or more locales use 'subdomain' or 'domain' strategy but Advanced URL Routing is disabled — enable it under /security/locales",
    });
  }
  for (const l of locales) {
    if ((l.urlStrategy === "subdomain" || l.urlStrategy === "domain") && !l.urlHost) {
      warnings.push({
        code: "missing-url-host",
        message: `locale '${l.code}' uses url_strategy='${l.urlStrategy}' without url_host`,
      });
    }
  }
  // Default-locale 'none' alongside subdirectory siblings is a common
  // mixed config; surface it so users know the default's URL stays bare
  // while siblings get prefixed.
  const def = locales.find((l) => l.isDefault);
  const subdirSiblings = locales.filter((l) => !l.isDefault && l.urlStrategy === "subdirectory");
  if (def && def.urlStrategy === "none" && subdirSiblings.length > 0) {
    warnings.push({
      code: "mixed-default-none-subdir",
      message: `default locale '${def.code}' uses 'none' while ${subdirSiblings
        .map((l) => l.code)
        .join(
          ", ",
        )} use 'subdirectory' — this is valid but unusual; verify hreflang renders correctly`,
    });
  }
  return warnings;
}

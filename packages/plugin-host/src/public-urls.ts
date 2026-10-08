// SPDX-License-Identifier: MPL-2.0

/**
 * #590 — absolute public page URLs, resolved in ONE place.
 *
 * Canonical, og:url, the sitemap `<loc>`, every hreflang/x-default
 * target and every language-switcher link must be byte-identical for the
 * same page. They used to come from two builders: core's canonical
 * (which follows the deploy target's `pageUrlStyle`) and a plugin's own
 * `base + current_path` (which did not), so hreflang said `/en/about`
 * while the canonical said `/en/about/` — inconsistent alternates and a
 * 301 hop per alternate on Firebase.
 *
 * Now core owns the whole URL: the materialized path
 * (`pages.current_path`), the host from the URL composition point's
 * `host` slot (resolved here at render time — it is not materialized),
 * the canonical override, and the trailing slash of the serving target.
 * Plugins never build page URLs; they ask core for them
 * (`pages.resolve_public_urls`, which calls this function).
 */

import { type PageUrlStyle, resolveCanonicalUrl } from "@caelo-cms/shared";
import type { RenderScope } from "./dispatch.js";
import { collectUrlAnnotations, hasHostContribution, resolvePageHost } from "./url-composition.js";

/** What the builder needs to know about one page. */
export interface PublicUrlPage {
  readonly id: string;
  readonly slug: string;
  /** `pages.current_path` — the composed, materialized path. */
  readonly currentPath: string;
  /** `pages_seo.canonical_url`, or null. */
  readonly canonicalOverride: string | null;
}

/** The render-wide inputs: the site origin and the serving target's style. */
export interface PublicUrlContext {
  readonly siteBaseUrl: string;
  readonly pageUrlStyle: PageUrlStyle;
}

/**
 * Resolve the absolute public URL of every given page.
 *
 * The host-slot annotations are collected only when a plugin claims the
 * `host` slot, so a single-host site pays no plugin round-trip. Loud
 * (no-fallbacks): a failing annotation op or a host contribution that
 * throws (e.g. a host-strategy locale without a configured host)
 * propagates — a URL on a silently substituted host is worse than a
 * failed render.
 *
 * @returns pageId → absolute URL, for every page in `pages`.
 */
export async function resolvePublicPageUrls(
  pages: ReadonlyArray<PublicUrlPage>,
  urlContext: PublicUrlContext,
  scope: RenderScope,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pages.length === 0) return out;
  const annotations = hasHostContribution()
    ? await collectUrlAnnotations(
        pages.map((p) => p.id),
        scope,
      )
    : new Map<string, Record<string, unknown>>();
  for (const page of pages) {
    // An overridden canonical never consults the host, so skip encoding
    // (a misconfigured host must not break a page that does not use it).
    const host =
      page.canonicalOverride || !hasHostContribution()
        ? null
        : resolvePageHost({
            pageId: page.id,
            slug: page.slug,
            // The host slot does not depend on the home designation; the
            // path half of composition is already materialized.
            isHomePage: false,
            annotations: annotations.get(page.id) ?? {},
          });
    out.set(
      page.id,
      resolveCanonicalUrl({
        siteBaseUrl: urlContext.siteBaseUrl,
        pagePath: page.currentPath,
        override: page.canonicalOverride,
        pageUrlStyle: urlContext.pageUrlStyle,
        host,
      }),
    );
  }
  return out;
}

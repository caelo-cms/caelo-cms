// SPDX-License-Identifier: MPL-2.0

/**
 * #1142 — the `BreadcrumbList` items of an editor preview: the trail the
 * page's breadcrumbs rendered, labelled with each page's short title in
 * the caller's draft view and linked with the same public URL builder as
 * the canonical. The static generator's SEO pass does the same from the
 * main line; both go through `breadcrumbJsonLdItems`, so a page shows the
 * same structured data in the preview and after Publish live.
 *
 * #1212 — the pages and their canonical overrides come from the render's
 * site view (no query here); only the plugins' URL builders are asked,
 * with no transaction held.
 */

import { type RenderScope, resolvePublicPageUrls } from "@caelo-cms/plugin-host";
import {
  type BreadcrumbJsonLdItem,
  breadcrumbJsonLdItems,
  type PageUrlStyle,
} from "@caelo-cms/shared";
import type { SiteView } from "../../site-view.js";

/**
 * Items for `renderSeoHead`'s `breadcrumbs`; empty when the page rendered
 * no trail. A trail page that is not published in the draft view has no
 * public URL and is left out, as in the build.
 */
export async function previewBreadcrumbs(
  view: SiteView,
  trail: readonly string[] | null,
  opts: {
    readonly siteBaseUrl: string;
    readonly pageUrlStyle: PageUrlStyle;
    readonly renderScope: RenderScope;
  },
): Promise<BreadcrumbJsonLdItem[]> {
  if (trail === null || trail.length === 0) return [];
  const wanted = new Set(trail);
  const pages = view.pages.filter((p) => wanted.has(p.id) && p.status === "published");
  const urls = await resolvePublicPageUrls(
    pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      currentPath: p.currentPath,
      canonicalOverride: view.canonicalOverrides.get(p.id) ?? null,
    })),
    { siteBaseUrl: opts.siteBaseUrl, pageUrlStyle: opts.pageUrlStyle },
    opts.renderScope,
  );
  const byId = new Map(pages.map((p) => [p.id, p]));
  return breadcrumbJsonLdItems(trail, (id) => {
    const page = byId.get(id);
    const url = urls.get(id);
    return page && url !== undefined ? { name: page.shortTitle, url } : null;
  });
}

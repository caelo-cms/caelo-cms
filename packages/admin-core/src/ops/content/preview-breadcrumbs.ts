// SPDX-License-Identifier: MPL-2.0

/**
 * #1142 — the `BreadcrumbList` items of an editor preview: the trail the
 * page's breadcrumbs rendered, labelled with each page's short title in
 * the caller's draft view and linked with the same public URL builder as
 * the canonical. The static generator's SEO pass does the same from the
 * main line; both go through `breadcrumbJsonLdItems`, so a page shows the
 * same structured data in the preview and after Publish live.
 */

import { type RenderScope, resolvePublicPageUrls } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type BreadcrumbJsonLdItem,
  breadcrumbJsonLdItems,
  type PageUrlStyle,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { loadPagesInView } from "../../lists/pages-view.js";

/**
 * Items for `renderSeoHead`'s `breadcrumbs`; empty when the page rendered
 * no trail. A trail page that is not published in the draft view has no
 * public URL and is left out, as in the build.
 */
export async function previewBreadcrumbs(
  tx: TransactionRunner,
  trail: readonly string[] | null,
  opts: {
    readonly chatBranchId: string | null;
    readonly siteBaseUrl: string;
    readonly pageUrlStyle: PageUrlStyle;
    readonly renderScope: RenderScope;
  },
): Promise<BreadcrumbJsonLdItem[]> {
  if (trail === null || trail.length === 0) return [];
  const wanted = new Set(trail);
  const pages = (await loadPagesInView(tx, opts.chatBranchId)).filter(
    (p) => wanted.has(p.id) && p.status === "published",
  );
  const overrides = new Map<string, string | null>();
  // Per-id query — same Bun-SQL constraint as the generator's SEO pass.
  for (const p of pages) {
    const rows = (await tx.execute(sql`
      SELECT canonical_url FROM pages_seo WHERE page_id = ${p.id}::uuid LIMIT 1
    `)) as unknown as { canonical_url: string | null }[];
    overrides.set(p.id, rows[0]?.canonical_url || null);
  }
  const urls = await resolvePublicPageUrls(
    pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      currentPath: p.currentPath,
      canonicalOverride: overrides.get(p.id) ?? null,
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

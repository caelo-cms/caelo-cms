// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the build's SEO pass in one call, for tests that check its output
 * on a few pages: prepared for exactly these pages, applied as one batch,
 * sitemap written into `buildDir` (what generate.ts does batch by batch).
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildPluginServices } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { PageUrlStyle, SiteSeoSettings } from "@caelo-cms/shared";
import {
  bodyContentDigest,
  ContentStates,
  MediaPass,
  prepareSeoPass,
} from "@caelo-cms/static-generator";
import type { RenderFailure } from "../../deploy/render-failures.js";

export async function runSeoPass(args: {
  tx: TransactionRunner;
  plugins: BuildPluginServices;
  buildDir: string;
  /** Where og:images are read from (none of these fixtures has one unless set). */
  mediaRoot: string;
  pages: {
    pageId: string;
    pageSlug: string;
    pageTitle?: string;
    html: string;
    breadcrumbTrail?: readonly string[] | null;
  }[];
  /** #1752 — the title template and site name default to today's title and none. */
  settings: Omit<SiteSeoSettings, "titleTemplate" | "siteName"> &
    Partial<Pick<SiteSeoSettings, "titleTemplate" | "siteName">>;
  pageUrlStyle: PageUrlStyle;
  notFoundPageId: string | null;
  /** #1452 — the theme's bound default share image; none unless set. */
  siteShareImageAssetId?: string | null;
  /** The feed every page links; none unless set. */
  feed?: { readonly url: string; readonly title: string } | null;
  /** `report` builds as a Stage does (#1719); default `refuse`, as every other build. */
  unresolved?: "refuse" | "report";
}): Promise<{
  sitemapEmitted: boolean;
  extraSitemaps: string[];
  renderFailures: readonly RenderFailure[];
}> {
  const media = new MediaPass({
    tx: args.tx,
    buildDir: args.buildDir,
    mediaRoot: args.mediaRoot,
    settings: { cdnEnabled: false, threshold: 5 },
    delivery: "link",
    unresolved: args.unresolved ?? "refuse",
  });
  const seo = await prepareSeoPass({
    tx: args.tx,
    plugins: args.plugins,
    media,
    pageIds: [...new Set(args.pages.map((p) => p.pageId))],
    settings: { titleTemplate: "{page_title}", siteName: null, ...args.settings },
    pageUrlStyle: args.pageUrlStyle,
    notFoundPageId: args.notFoundPageId,
    siteShareImageAssetId: args.siteShareImageAssetId ?? null,
    // Only these pages are built: none of the others counts as removed.
    contentStates: await ContentStates.load(args.tx, {
      publishAt: new Date().toISOString(),
      full: false,
    }),
    feed: args.feed ?? null,
  });
  const pages = args.pages.map((p) => ({
    ...p,
    pageTitle: p.pageTitle ?? p.pageSlug,
    bodyDigest: bodyContentDigest(p.html),
  }));
  // #1753 — what the batch's structured data could not carry as given.
  const batchFailures = await seo.apply(pages);
  seo.recordStates(pages);
  pages.forEach((p, i) => {
    const original = args.pages[i];
    if (original) original.html = p.html;
  });
  const write = (rel: string, content: string) =>
    writeFile(join(args.buildDir, rel), content, "utf8");
  const sitemapEmitted = await seo.writeSitemap(write);
  // #1761 — the news and video sitemaps, as the generator writes them.
  const extraSitemaps = await seo.writeExtraSitemaps(write);
  return {
    sitemapEmitted,
    extraSitemaps,
    renderFailures: [...seo.renderFailures, ...batchFailures],
  };
}

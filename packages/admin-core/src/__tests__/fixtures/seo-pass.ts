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
import { MediaPass, prepareSeoPass } from "@caelo-cms/static-generator";

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
  settings: SiteSeoSettings;
  pageUrlStyle: PageUrlStyle;
  notFoundPageId: string | null;
}): Promise<{ sitemapEmitted: boolean }> {
  const media = new MediaPass({
    tx: args.tx,
    buildDir: args.buildDir,
    mediaRoot: args.mediaRoot,
    settings: { cdnEnabled: false, threshold: 5 },
    delivery: "link",
  });
  const seo = await prepareSeoPass({
    tx: args.tx,
    plugins: args.plugins,
    media,
    pageIds: [...new Set(args.pages.map((p) => p.pageId))],
    settings: args.settings,
    pageUrlStyle: args.pageUrlStyle,
    notFoundPageId: args.notFoundPageId,
  });
  const pages = args.pages.map((p) => ({ ...p, pageTitle: p.pageTitle ?? p.pageSlug }));
  await seo.apply(pages);
  pages.forEach((p, i) => {
    const original = args.pages[i];
    if (original) original.html = p.html;
  });
  const sitemapEmitted = await seo.writeSitemap((rel, content) =>
    writeFile(join(args.buildDir, rel), content, "utf8"),
  );
  return { sitemapEmitted };
}

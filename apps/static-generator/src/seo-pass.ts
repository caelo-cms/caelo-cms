// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — static-generator SEO pass.
 *
 *  - Per-page <head> rewriter — injects meta description, canonical,
 *    Open Graph, Twitter card, and JSON-LD WebPage. hreflang returns
 *    as a head contribution from the international-site plugin (#398).
 *  - sitemap.xml writer — flat list of every published non-noindex
 *    page, with lastmod/changefreq/priority. Skipped entirely when
 *    site_defaults.sitemap_enabled = false.
 *  - robots.txt extension — adds `Sitemap:` line in production.
 *
 * Ordering: runs AFTER `media-pass` (URLs already rewritten to
 * /_assets/...) so the og:image href resolves to the deployed asset
 * path. Failures throw — per the no-fallbacks rule, a missing or
 * deleted og_image_asset_id stops the deploy loudly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  injectSeoIntoHead,
  pageIsLocaleHome,
  renderSeoHead,
  resolveCanonicalUrl,
  type SiteSeoSettings,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

interface PageSeoBundle {
  pageId: string;
  slug: string;
  locale: string;
  title: string;
  metaDescription: string;
  noindex: boolean;
  changefreq: string;
  priority: number;
  canonicalOverride: string | null;
  ogImageAssetId: string | null;
  updatedAt: string;
}

export interface SeoPagesContext {
  pageSlug: string;
  pageLocale: string;
  pageTitle: string;
  html: string;
}

export async function runSeoPass(args: {
  tx: TransactionRunner;
  buildDir: string;
  pages: SeoPagesContext[];
  settings: SiteSeoSettings;
  /** `noindex` deploy target overrides per-page settings — staging
      stays out of the sitemap entirely regardless of the page flag. */
  envIsNoindex: boolean;
  /** v0.2.85 — per-target page emission style. Drives canonical
   *  trailing-slash decisions to match what the bucket serves. */
  pageUrlStyle?: "directory" | "no-extension";
}): Promise<{ sitemapEmitted: boolean }> {
  if (args.pages.length === 0) {
    return { sitemapEmitted: false };
  }

  // Resolve every page's slug to its sidecar SEO row.
  const slugs = args.pages.map((p) => p.pageSlug);
  // Per-id query — same Bun-SQL constraint as media.list.
  const seoBundles: PageSeoBundle[] = [];
  for (const slug of slugs) {
    const rows = (await args.tx.execute(sql`
      SELECT
        p.id::text AS page_id, p.slug, p.locale, p.title,
        coalesce(s.meta_description, '') AS meta_description,
        coalesce(s.noindex, false) AS noindex,
        coalesce(s.changefreq, 'weekly') AS changefreq,
        coalesce(s.priority, 0.5) AS priority,
        s.canonical_url AS canonical_override,
        s.og_image_asset_id::text AS og_image_asset_id,
        p.updated_at
      FROM pages p
      LEFT JOIN pages_seo s ON s.page_id = p.id
      WHERE p.slug = ${slug} AND p.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as {
      page_id: string;
      slug: string;
      locale: string;
      title: string;
      meta_description: string;
      noindex: boolean;
      changefreq: string;
      priority: number | string;
      canonical_override: string | null;
      og_image_asset_id: string | null;
      updated_at: Date | string;
    }[];
    const r = rows[0];
    if (!r) continue;
    seoBundles.push({
      pageId: r.page_id,
      slug: r.slug,
      locale: r.locale,
      title: r.title,
      metaDescription: r.meta_description,
      noindex: r.noindex,
      changefreq: r.changefreq,
      priority: Number(r.priority),
      canonicalOverride: r.canonical_override,
      ogImageAssetId: r.og_image_asset_id,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    });
  }

  // Resolve every og_image_asset_id to a public URL (the media-pass
  // already wrote /_assets/...; we look up the variant we want for OG).
  const ogImageAssetIds = [
    ...new Set(seoBundles.map((b) => b.ogImageAssetId).filter((x): x is string => x !== null)),
  ];
  const ogImageUrlByAsset = new Map<string, string>();
  for (const id of ogImageAssetIds) {
    // Resolve to the slug so the og:image URL matches the media-pass
    // output (`/_assets/<slug>.<ext>` for orig, `/_assets/<slug>/<variant>.<ext>`
    // for a named variant); the UUID id stays internal.
    const rows = (await args.tx.execute(sql`
      SELECT ma.slug, mv.variant, mv.format
      FROM media_variants mv
      JOIN media_assets ma ON ma.id = mv.asset_id
      WHERE mv.asset_id = ${id}::uuid
        AND ma.deleted_at IS NULL
      ORDER BY
        CASE mv.variant
          WHEN 'webp-1200' THEN 0
          WHEN 'webp-1600' THEN 1
          WHEN 'webp-800'  THEN 2
          WHEN 'orig'      THEN 3
          ELSE 4
        END
      LIMIT 1
    `)) as unknown as { slug: string; variant: string; format: string }[];
    const v = rows[0];
    if (!v) {
      throw new Error(
        `static-generator: og:image asset ${id} has no variants — deploy aborted (no-fallbacks)`,
      );
    }
    const ext = v.format === "jpeg" ? "jpg" : v.format;
    const base = args.settings.siteBaseUrl.replace(/\/$/, "");
    const assetUrl =
      v.variant === "orig"
        ? `${base}/_assets/${v.slug}.${ext}`
        : `${base}/_assets/${v.slug}/${v.variant}.${ext}`;
    ogImageUrlByAsset.set(id, assetUrl);
  }

  // 0184 — the designated homepage id, still parked per locale row
  // until #384 moves it to site_defaults. Looked up via each page's
  // own locale so the designation semantics survive the #383 cut.
  const homeRows = (await args.tx.execute(sql`
    SELECT code, home_page_id::text AS home_page_id FROM locales
  `)) as unknown as { code: string; home_page_id: string | null }[];
  const homePageByLocale = new Map(homeRows.map((r) => [r.code, r.home_page_id]));

  // Inject the head block per page. Match by (slug, locale).
  const bundleBySlug = new Map<string, PageSeoBundle>(
    seoBundles.map((b) => [`${b.slug}|${b.locale}`, b]),
  );
  for (const p of args.pages) {
    const bundle = bundleBySlug.get(`${p.pageSlug}|${p.pageLocale}`);
    if (!bundle) continue;
    const canonical = resolveCanonicalUrl({
      siteBaseUrl: args.settings.siteBaseUrl,
      pageSlug: bundle.slug,
      override: bundle.canonicalOverride,
      pageUrlStyle: args.pageUrlStyle,
      isHomePage: pageIsLocaleHome(bundle.pageId, bundle.slug, homePageByLocale.get(bundle.locale)),
    });
    const ogImageUrl = bundle.ogImageAssetId
      ? (ogImageUrlByAsset.get(bundle.ogImageAssetId) ?? null)
      : null;
    const headBlock = renderSeoHead({
      title: bundle.title,
      metaDescription: bundle.metaDescription,
      canonical,
      noindex: bundle.noindex || args.envIsNoindex,
      ogImageUrl,
      organization: args.settings.organization,
    });
    p.html = injectSeoIntoHead(p.html, headBlock);
  }

  // sitemap.xml — only when enabled AND env isn't noindex.
  const sitemapEnabled = !args.envIsNoindex && args.settings.siteBaseUrl.length > 0;
  if (sitemapEnabled) {
    const entries = seoBundles
      .filter((b) => !b.noindex)
      .map((b) => {
        const canonical = resolveCanonicalUrl({
          siteBaseUrl: args.settings.siteBaseUrl,
          pageSlug: b.slug,
          override: b.canonicalOverride,
          pageUrlStyle: args.pageUrlStyle,
          isHomePage: pageIsLocaleHome(b.pageId, b.slug, homePageByLocale.get(b.locale)),
        });
        return [
          "  <url>",
          `    <loc>${enc(canonical)}</loc>`,
          `    <lastmod>${b.updatedAt.slice(0, 10)}</lastmod>`,
          `    <changefreq>${b.changefreq}</changefreq>`,
          `    <priority>${b.priority.toFixed(1)}</priority>`,
          "  </url>",
        ].join("\n");
      });
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...entries,
      "</urlset>",
      "",
    ].join("\n");
    await mkdir(args.buildDir, { recursive: true });
    await writeFile(join(args.buildDir, "sitemap.xml"), xml, "utf8");
  }
  return { sitemapEmitted: sitemapEnabled };
}

function enc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Read the SEO settings from `site_defaults` for the deploy run.
 * Falls back to a sensible local default when unseeded — same shape
 * as `site_defaults.get_seo` in the admin op layer.
 */
export async function readSeoSettings(tx: TransactionRunner): Promise<SiteSeoSettings> {
  const rows = (await tx.execute(sql`
    SELECT site_base_url, sitemap_enabled, organization_json::text AS organization_json
    FROM site_defaults WHERE id = 1
    LIMIT 1
  `)) as unknown as {
    site_base_url: string;
    sitemap_enabled: boolean;
    organization_json: string | null;
  }[];
  const r = rows[0];
  let organization: SiteSeoSettings["organization"] = {};
  if (r?.organization_json) {
    try {
      organization = JSON.parse(r.organization_json) as SiteSeoSettings["organization"];
    } catch {
      // Defensive: malformed JSON column is treated as empty.
      organization = {};
    }
  }
  return {
    siteBaseUrl: r?.site_base_url ?? "http://localhost:8082",
    sitemapEnabled: r?.sitemap_enabled ?? true,
    organization,
  };
}

/**
 * Build a robots.txt body that includes the Sitemap: line in
 * production. Staging stays Disallow:/ regardless of sitemap state.
 */
export function buildRobotsTxtWithSitemap(
  robots: "index" | "noindex",
  siteBaseUrl: string,
  sitemapEmitted: boolean,
): string {
  if (robots === "noindex") return "User-agent: *\nDisallow: /\n";
  if (!sitemapEmitted) return "User-agent: *\nAllow: /\n";
  const base = siteBaseUrl.replace(/\/$/, "");
  return `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
}

// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — static-generator SEO pass.
 *
 *  - Per-page <head> rewriter — injects meta description, canonical,
 *    Open Graph, Twitter card, and JSON-LD WebPage. hreflang returns
 *    as a head contribution from the international-site plugin (#398).
 *  - sitemap.xml writer — flat list of every published non-noindex
 *    page, with lastmod/changefreq/priority.
 *  - robots.txt extension — adds `Sitemap:` line in production.
 *
 * Environment-independent on purpose: a staging build is byte-for-byte
 * what "Publish live" ships to production (deploy.promote copies it),
 * so nothing here may depend on the target's `robotsDefault`. The page
 * `<meta name="robots">` carries ONLY the page's own SEO setting, and
 * the sitemap is written for every env. Keeping staging out of search
 * engines is the job of the per-env artefacts that promote rewrites or
 * drops: robots.txt (`Disallow: /`, no `Sitemap:` line) and the
 * `X-Robots-Tag: noindex` response header the staging serving layer
 * adds (Caddy staging vhost, Firebase staging version config, the GCS
 * staging-preview proxy). Baking the env's noindex into the HTML is
 * what made every promoted page `noindex` in production.
 *
 * Ordering: runs AFTER `media-pass` (URLs already rewritten to
 * /_assets/...) so the og:image href resolves to the deployed asset
 * path. Failures throw — per the no-fallbacks rule, a missing or
 * deleted og_image_asset_id stops the deploy loudly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BuildPluginServices, composeHeadBlock } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  applyDocumentLanguage,
  type BreadcrumbJsonLdItem,
  breadcrumbJsonLdItems,
  injectSeoIntoHead,
  type PageUrlStyle,
  pagedUrl,
  renderSeoHead,
  resolveDocumentLanguage,
  type SiteSeoSettings,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { readStoredMedia, writePublishedMedia } from "./media-asset-path.js";

interface PageSeoBundle {
  pageId: string;
  slug: string;
  /** The composed public path (pages.current_path, #390). */
  currentPath: string;
  title: string;
  shortTitle: string;
  metaDescription: string;
  noindex: boolean;
  changefreq: string;
  priority: number;
  canonicalOverride: string | null;
  ogImageAssetId: string | null;
  updatedAt: string;
}

export interface SeoPagesContext {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  html: string;
  /** #1142 — the trail the page's breadcrumbs rendered (`ListPageContext.breadcrumbTrail`). */
  breadcrumbTrail?: readonly string[] | null;
  /**
   * #1257 — page `n` ≥ 2 of a paginated overview (same page id as page
   * 1): self-canonical, `noindex` and out of the sitemap unless indexable.
   */
  followUp?: { readonly page: number; readonly indexable: boolean };
}

export async function runSeoPass(args: {
  tx: TransactionRunner;
  /** #605 — the plugin host answering head contributions and URLs. */
  plugins: BuildPluginServices;
  buildDir: string;
  /** Absolute filesystem path to the media storage root (`MEDIA_ROOT_DIR`):
   *  the og:image file is published from here (#667). */
  mediaRoot: string;
  pages: SeoPagesContext[];
  settings: SiteSeoSettings;
  /** The target's page emission style (v0.2.85). Every URL of the pass
   *  — canonical, sitemap `<loc>`, plugin hreflang — follows it (#590). */
  pageUrlStyle: PageUrlStyle;
  /** #802 — the designated 404 page (shipped as `/404.html`), or null.
   *  It gets {@link notFoundPageSeo} and never enters the sitemap. */
  notFoundPageId: string | null;
}): Promise<{ sitemapEmitted: boolean }> {
  if (args.pages.length === 0) {
    return { sitemapEmitted: false };
  }

  // Resolve every page to its sidecar SEO row — by id: slugs repeat
  // across parents once pages nest (epic #690).
  // Per-id query — same Bun-SQL constraint as media.list.
  const seoBundles: PageSeoBundle[] = [];
  // A paginated overview's follow-up pages share its id (#1257): one bundle each.
  for (const pageId of new Set(args.pages.map((p) => p.pageId))) {
    const rows = (await args.tx.execute(sql`
      SELECT
        p.id::text AS page_id, p.slug, p.current_path, p.title, p.short_title,
        coalesce(s.meta_description, '') AS meta_description,
        coalesce(s.noindex, false) AS noindex,
        coalesce(s.changefreq, 'weekly') AS changefreq,
        coalesce(s.priority, 0.5) AS priority,
        s.canonical_url AS canonical_override,
        s.og_image_asset_id::text AS og_image_asset_id,
        p.updated_at
      FROM pages p
      LEFT JOIN pages_seo s ON s.page_id = p.id
      WHERE p.id = ${pageId}::uuid AND p.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as {
      page_id: string;
      slug: string;
      current_path: string;
      title: string;
      short_title: string;
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
      currentPath: r.current_path,
      title: r.title,
      shortTitle: r.short_title,
      metaDescription: r.meta_description,
      noindex: r.noindex,
      changefreq: r.changefreq,
      priority: Number(r.priority),
      canonicalOverride: r.canonical_override,
      ogImageAssetId: r.og_image_asset_id,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    });
  }

  // Resolve every og_image_asset_id to a public URL and publish that file
  // into the build: the og:image need not appear on any page, so the media
  // pass may not have copied it. Same content-hashed name as the media
  // pass (#667), so a file that is also on a page lands on the same path.
  const ogImageAssetIds = [
    ...new Set(seoBundles.map((b) => b.ogImageAssetId).filter((x): x is string => x !== null)),
  ];
  const ogImageUrlByAsset = new Map<string, string>();
  for (const id of ogImageAssetIds) {
    const rows = (await args.tx.execute(sql`
      SELECT ma.slug, ma.visibility, mv.variant, mv.format, mv.storage_key
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
    `)) as unknown as {
      slug: string;
      visibility: "library" | "reference";
      variant: string;
      format: string;
      storage_key: string;
    }[];
    const v = rows[0];
    if (!v) {
      throw new Error(
        `static-generator: og:image asset ${id} has no variants — deploy aborted (no-fallbacks)`,
      );
    }
    if (v.visibility === "reference") {
      // #531 — same rule as page images: references are never published.
      throw new Error(
        `static-generator: og:image asset ${v.slug} is a reference image and is never published. ` +
          "Next step: pick a library image for the page's og:image, or mark this one as a library " +
          'image (AI tool: set_media_visibility_many with visibility: "library").',
      );
    }
    const bytes = await readStoredMedia(args.mediaRoot, v.storage_key);
    if (bytes === null) {
      throw new Error(
        `static-generator: the stored file of og:image asset ${v.slug} (${v.variant}) is missing from ${args.mediaRoot}. ` +
          "Next step: find it with list_missing_media and restore it (import_media_from_urls when it came from a URL, " +
          "or ask the operator to re-upload it), or pick another og:image for the page (set_page_seo_many).",
      );
    }
    const relPath = await writePublishedMedia({
      buildDir: args.buildDir,
      ref: v.slug,
      isSlug: true,
      variant: v.variant,
      format: v.format,
      bytes,
    });
    const base = args.settings.siteBaseUrl.replace(/\/$/, "");
    ogImageUrlByAsset.set(id, `${base}/${relPath}`);
  }

  // #391 — collect every plugin's head/sitemap contributions in ONE
  // batch call before the loops. Zod-validated + contradiction-checked
  // by the host; serialization shares the exact code path the preview
  // uses (composeHeadBlock), so both surfaces stay byte-identical.
  const contributions = await args.plugins.collectContributions(
    seoBundles.map((b) => b.pageId),
    { siteBaseUrl: args.settings.siteBaseUrl, pageUrlStyle: args.pageUrlStyle },
  );

  // #590 — canonical and sitemap `<loc>` come from the ONE public URL
  // builder plugins also use for hreflang, so they agree byte for byte
  // (host-strategy locales included).
  const crumbPages = await loadCrumbPages(args.tx, args.pages, seoBundles);
  const publicUrls = await args.plugins.resolvePublicPageUrls(
    [...seoBundles, ...crumbPages].map((b) => ({
      id: b.pageId,
      slug: b.slug,
      currentPath: b.currentPath,
      canonicalOverride: b.canonicalOverride,
    })),
    { siteBaseUrl: args.settings.siteBaseUrl, pageUrlStyle: args.pageUrlStyle },
  );
  const publicUrlOf = (b: PageSeoBundle): string => {
    const url = publicUrls.get(b.pageId);
    if (url === undefined) throw new Error(`seo-pass: no public URL resolved for page ${b.pageId}`);
    return url;
  };
  // #1257 — follow-up pages are self-canonical: built from the overview's
  // own public URL, never from a canonical override pointing elsewhere.
  const pagedIds = new Set(args.pages.filter((p) => p.followUp).map((p) => p.pageId));
  const ownUrls =
    pagedIds.size === 0
      ? new Map<string, string>()
      : await args.plugins.resolvePublicPageUrls(
          seoBundles
            .filter((b) => pagedIds.has(b.pageId))
            .map((b) => ({
              id: b.pageId,
              slug: b.slug,
              currentPath: b.currentPath,
              canonicalOverride: null,
            })),
          { siteBaseUrl: args.settings.siteBaseUrl, pageUrlStyle: args.pageUrlStyle },
        );
  const followUpUrlOf = (b: PageSeoBundle, n: number): string => {
    const url = ownUrls.get(b.pageId);
    if (url === undefined) throw new Error(`seo-pass: no public URL resolved for page ${b.pageId}`);
    return pagedUrl(url, n, args.pageUrlStyle);
  };

  // #390 — canonical follows the MATERIALIZED composed path; home
  // designation, prefixes, and slug formats are already baked into
  // pages.current_path by the write ops.
  const bundleById = new Map<string, PageSeoBundle>(seoBundles.map((b) => [b.pageId, b]));
  const crumbById = new Map<string, CrumbPage>(
    [...seoBundles, ...crumbPages].map((b) => [b.pageId, b]),
  );
  const crumbOf = (pageId: string): BreadcrumbJsonLdItem | null => {
    const c = crumbById.get(pageId);
    const url = c ? publicUrls.get(pageId) : undefined;
    return c && url !== undefined ? { name: c.shortTitle, url } : null;
  };
  for (const p of args.pages) {
    const bundle = bundleById.get(p.pageId);
    if (!bundle) continue;
    const isNotFoundPage = bundle.pageId === args.notFoundPageId;
    const ogImageUrl = bundle.ogImageAssetId
      ? (ogImageUrlByAsset.get(bundle.ogImageAssetId) ?? null)
      : null;
    const headBlock = renderSeoHead({
      title: bundle.title,
      metaDescription: bundle.metaDescription,
      ogImageUrl,
      organization: args.settings.organization,
      ...(isNotFoundPage
        ? notFoundPageSeo()
        : {
            canonical: p.followUp ? followUpUrlOf(bundle, p.followUp.page) : publicUrlOf(bundle),
            noindex: bundle.noindex || (p.followUp !== undefined && !p.followUp.indexable),
            breadcrumbs: breadcrumbJsonLdItems(p.breadcrumbTrail ?? null, crumbOf),
          }),
    });
    const head = contributions.head.get(bundle.pageId);
    p.html = injectSeoIntoHead(
      p.html,
      // #802 — no plugin head contributions on the 404 page: it answers
      // every unknown URL, so hreflang alternates would be false claims.
      composeHeadBlock(
        headBlock,
        isNotFoundPage ? undefined : p.followUp ? followUpHeadEntries(head) : head,
      ),
    );
    // `<html lang>` — same resolution as the admin preview.
    p.html = applyDocumentLanguage(
      p.html,
      resolveDocumentLanguage({
        contributed: contributions.lang.get(bundle.pageId),
        siteLanguage: args.settings.siteLanguage,
      }),
    );
  }

  // sitemap.xml — written for every env (see the file header): staging
  // never references it (its robots.txt has no `Sitemap:` line and the
  // host answers `X-Robots-Tag: noindex`), and promote ships it as-is.
  // #567 — the Owner's toggle gates it; robots.txt follows
  // `sitemapEmitted`, so turning it off also drops the `Sitemap:` line.
  const sitemapEnabled = args.settings.sitemapEnabled && args.settings.siteBaseUrl.length > 0;
  if (sitemapEnabled) {
    // #1257 — indexable follow-up pages of each overview, after page 1.
    const followUpsOf = new Map<string, number[]>();
    for (const p of args.pages) {
      if (!p.followUp?.indexable) continue;
      followUpsOf.set(p.pageId, [...(followUpsOf.get(p.pageId) ?? []), p.followUp.page]);
    }
    const entries = seoBundles
      .filter((b) => isSitemapEntry(b, args.notFoundPageId))
      // #391 — plugin-contributed exclusion (e.g. an unpublished
      // variant URL must not appear; clean-404 semantics).
      .filter((b) => contributions.sitemap.get(b.pageId)?.exclude !== true)
      .flatMap((b) => {
        const urlEntry = (loc: string, alternates: readonly string[]): string =>
          [
            "  <url>",
            `    <loc>${enc(loc)}</loc>`,
            ...alternates,
            `    <lastmod>${b.updatedAt.slice(0, 10)}</lastmod>`,
            `    <changefreq>${b.changefreq}</changefreq>`,
            `    <priority>${b.priority.toFixed(1)}</priority>`,
            "  </url>",
          ].join("\n");
        // #391 — contributed xhtml alternates (hreflang) inside the
        // page's <url> entry, sorted for deterministic output. Follow-up
        // pages carry none: the alternates are page 1's twins.
        const alternates = [...(contributions.sitemap.get(b.pageId)?.alternates ?? [])]
          .sort((x, y) => x.hreflang.localeCompare(y.hreflang))
          .map(
            (a) =>
              `    <xhtml:link rel="alternate" hreflang="${enc(a.hreflang)}" href="${enc(a.href)}" />`,
          );
        return [
          urlEntry(publicUrlOf(b), alternates),
          ...(followUpsOf.get(b.pageId) ?? []).map((n) => urlEntry(followUpUrlOf(b, n), [])),
        ];
      });
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...entries,
      "</urlset>",
      "",
    ].join("\n");
    await mkdir(args.buildDir, { recursive: true });
    await writeFile(join(args.buildDir, "sitemap.xml"), xml, "utf8");
  }
  return { sitemapEmitted: sitemapEnabled };
}

/**
 * #1257 — the plugin head entries a follow-up page keeps: everything but
 * hreflang alternates. Those name the overview's versions in other
 * languages — equivalents of page 1, not of page n — and a follow-up page
 * has no translated twin to point at.
 */
export function followUpHeadEntries<
  E extends { readonly kind: string; readonly hreflang?: string },
>(entries: readonly E[] | undefined): E[] | undefined {
  return entries?.filter((e) => !(e.kind === "link" && e.hreflang !== undefined));
}

/**
 * #802 — head fields of the 404 page. It is served for every unknown URL,
 * so it has no canonical URL of its own (no canonical, og:url or JSON-LD
 * url) and must never be indexed, whatever its page SEO says.
 */
export function notFoundPageSeo(): { canonical: null; noindex: true } {
  return { canonical: null, noindex: true };
}

/**
 * Does the page get a sitemap `<url>`? Not when it is noindex, and never
 * the 404 page (#802), which is not reachable at its own URL.
 */
export function isSitemapEntry(
  page: { readonly pageId: string; readonly noindex: boolean },
  notFoundPageId: string | null,
): boolean {
  return !page.noindex && page.pageId !== notFoundPageId;
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
 * Same shape as `site_defaults.get_seo` in the admin op layer. The
 * singleton row must exist: it carries the stored site language.
 *
 * Throws when the site base URL is not configured (#551): every canonical,
 * og:url, JSON-LD url and sitemap entry is absolute, and a substituted
 * localhost default shipped unreachable canonicals to production. The
 * message names the setting and how to set it.
 *
 * The site language comes back as stored, `null` when unset (migration
 * 0232): promote and rollback read this only for the base URL and ship an
 * already-built tree, so they must not be blocked by it. A new build goes
 * through {@link requireSiteLanguage}.
 */
export async function readSeoSettings(tx: TransactionRunner): Promise<StoredSeoSettings> {
  const rows = (await tx.execute(sql`
    SELECT site_base_url, sitemap_enabled, organization_json::text AS organization_json,
           site_language
    FROM site_defaults WHERE id = 1
    LIMIT 1
  `)) as unknown as {
    site_base_url: string | null;
    sitemap_enabled: boolean;
    organization_json: string | null;
    site_language: string | null;
  }[];
  const r = rows[0];
  if (!r) {
    // No row means no stored language for `<html lang>` either; a guessed
    // one would mislabel the whole site (CLAUDE.md §2).
    throw new Error(
      "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it. " +
        "Without it pages have no stored language for <html lang> and no site URL. " +
        "Next step: run the cms_admin migrations, then redeploy.",
    );
  }
  if (!r.site_base_url) {
    throw new Error(
      "Site base URL is not configured (site_defaults.site_base_url is NULL). Canonical " +
        "URLs, og:url, JSON-LD and the sitemap need the public site URL. Next step: ask the " +
        "AI in the editor chat to set it — it calls propose_set_site_seo({siteBaseUrl: " +
        '"https://<your domain>"}) and the Owner approves — or set it under Settings → SEO ' +
        "in the admin, or set CAELO_SITE_URL on the admin service (provisioning does this " +
        "from the install domain) and restart it. Then publish again.",
    );
  }
  let organization: SiteSeoSettings["organization"] = {};
  if (r.organization_json) {
    try {
      organization = JSON.parse(r.organization_json) as SiteSeoSettings["organization"];
    } catch {
      // Defensive: malformed JSON column is treated as empty.
      organization = {};
    }
  }
  return {
    siteBaseUrl: r.site_base_url,
    sitemapEnabled: r.sitemap_enabled,
    siteLanguage: r.site_language,
    organization,
  };
}

/** {@link SiteSeoSettings} as stored: the site language may be unset. */
export type StoredSeoSettings = Omit<SiteSeoSettings, "siteLanguage"> & {
  siteLanguage: string | null;
};

/**
 * Narrow the stored settings for a new build. Throws when the site language
 * is not configured (migration 0232): every built page needs a real
 * `<html lang>`, and a substituted `en` mislabels every non-English site.
 * The message names the setting and how to set it.
 */
export function requireSiteLanguage(settings: StoredSeoSettings): SiteSeoSettings {
  const { siteLanguage } = settings;
  if (!siteLanguage) {
    throw new Error(
      "Site language is not configured (site_defaults.site_language is NULL). Every page " +
        "needs <html lang> for screen readers and search engines. Next step: tell the AI in " +
        "the editor chat which language the site is written in — it calls " +
        'set_site_identity({siteLanguage: "<BCP 47 tag, e.g. de>"}) — or set it under ' +
        "Settings → SEO in the admin, then publish again.",
    );
  }
  return { ...settings, siteLanguage };
}

/**
 * Build a robots.txt body that includes the Sitemap: line in
 * production. Staging stays Disallow:/ regardless of sitemap state.
 * Used by the generator AND by every publisher's promote, which
 * rewrites robots.txt for the destination target.
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

/** What a crumb needs: its label and the inputs of the public URL builder. */
type CrumbPage = Pick<
  PageSeoBundle,
  "pageId" | "slug" | "currentPath" | "shortTitle" | "canonicalOverride"
>;

/**
 * The trail pages (#1142) this pass has no bundle for — an incremental
 * build re-renders a page without its unchanged ancestors. Only pages
 * published on the main line count: a draft ancestor has no public URL,
 * and its crumb is left out of the JSON-LD (see `breadcrumbJsonLdItems`).
 */
async function loadCrumbPages(
  tx: TransactionRunner,
  pages: readonly SeoPagesContext[],
  bundles: readonly PageSeoBundle[],
): Promise<CrumbPage[]> {
  const have = new Set(bundles.map((b) => b.pageId));
  const want = new Set<string>();
  for (const p of pages) for (const id of p.breadcrumbTrail ?? []) if (!have.has(id)) want.add(id);
  const out: CrumbPage[] = [];
  // Per-id query — same Bun-SQL constraint as the bundle loop above.
  for (const id of want) {
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, p.slug, p.current_path, p.short_title,
             s.canonical_url AS canonical_override
      FROM pages p
      LEFT JOIN pages_seo s ON s.page_id = p.id
      WHERE p.id = ${id}::uuid AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
        AND p.status = 'published'
      LIMIT 1
    `)) as unknown as {
      page_id: string;
      slug: string;
      current_path: string;
      short_title: string;
      canonical_override: string | null;
    }[];
    const r = rows[0];
    if (!r) continue;
    out.push({
      pageId: r.page_id,
      slug: r.slug,
      currentPath: r.current_path,
      shortTitle: r.short_title,
      canonicalOverride: r.canonical_override,
    });
  }
  return out;
}

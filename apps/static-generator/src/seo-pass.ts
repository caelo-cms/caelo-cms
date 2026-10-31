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
 *
 * #1271 — prepared once ({@link prepareSeoPass}: every page's SEO row,
 * plugin contributions and public URL — a small record per page) and
 * applied page batch by page batch, so the build never holds every page's
 * HTML for this pass; the sitemap is written from the records at the end.
 */

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
import type { MediaPass } from "./media-pass.js";

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

/** The SEO pass of one build, prepared once and applied page batch by page batch. */
export interface SeoPass {
  /** Inject head meta + `<html lang>` into one batch of pages, in place. */
  apply(pages: SeoPagesContext[]): Promise<void>;
  /**
   * Write sitemap.xml (when enabled) from what every batch recorded; call
   * once after the last batch. Returns whether it was written.
   */
  writeSitemap(write: (relPath: string, content: string) => Promise<void>): Promise<boolean>;
}

/** A JSON value bound as one jsonb parameter. */
function jsonb(value: unknown): ReturnType<typeof sql> {
  return sql`(${JSON.stringify(value)}::text)::jsonb`;
}

/**
 * Prepare the SEO pass of a build (#1271: so pages can be written batch by
 * batch instead of all held for one pass). Loads every page's SEO row in
 * one statement, publishes the og:images through the media pass, and asks
 * the plugins for every page's head/sitemap contributions and public URL —
 * a small per-page record each, never the HTML.
 */
export async function prepareSeoPass(args: {
  tx: TransactionRunner;
  /** #605 — the plugin host answering head contributions and URLs. */
  plugins: BuildPluginServices;
  /** The build's media pass: og:images are published through it (#667, #1271). */
  media: MediaPass;
  /** Every page this build renders (page 1 of each paginated overview). */
  pageIds: readonly string[];
  settings: SiteSeoSettings;
  /** The target's page emission style (v0.2.85). Every URL of the pass
   *  — canonical, sitemap `<loc>`, plugin hreflang — follows it (#590). */
  pageUrlStyle: PageUrlStyle;
  /** #802 — the designated 404 page (shipped as `/404.html`), or null.
   *  It gets {@link notFoundPageSeo} and never enters the sitemap. */
  notFoundPageId: string | null;
}): Promise<SeoPass> {
  const { tx, plugins, settings, pageUrlStyle, notFoundPageId } = args;
  const urlArgs = { siteBaseUrl: settings.siteBaseUrl, pageUrlStyle };

  // Every page's sidecar SEO row — by id: slugs repeat across parents
  // once pages nest (epic #690). One statement, the ids bound as jsonb.
  const seoBundles: PageSeoBundle[] = [];
  const BUNDLE_BATCH = 1000;
  for (let at = 0; at < args.pageIds.length; at += BUNDLE_BATCH) {
    const ids = args.pageIds.slice(at, at + BUNDLE_BATCH);
    const rows = (await tx.execute(sql`
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
      WHERE p.id IN (SELECT jsonb_array_elements_text(${jsonb(ids)})::uuid)
        AND p.deleted_at IS NULL
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
    for (const r of rows) {
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
  }
  // The sitemap lists pages in the build's page order (deterministic).
  const order = new Map(args.pageIds.map((id, i) => [id, i]));
  seoBundles.sort((a, b) => (order.get(a.pageId) ?? 0) - (order.get(b.pageId) ?? 0));
  const bundleById = new Map<string, PageSeoBundle>(seoBundles.map((b) => [b.pageId, b]));

  // Resolve every og_image_asset_id to a public URL and publish that file
  // with the build: the og:image need not appear on any page, so the media
  // pass may not have published it. Same content-hashed name as the media
  // pass (#667), so a file that is also on a page lands on the same path.
  const base = settings.siteBaseUrl.replace(/\/$/, "");
  const ogImageUrlByAsset = new Map<string, string>();
  for (const id of new Set(seoBundles.map((b) => b.ogImageAssetId))) {
    if (id === null) continue;
    ogImageUrlByAsset.set(id, `${base}/${await args.media.publishOgImage(id)}`);
  }

  // #391 — collect every plugin's head/sitemap contributions in ONE
  // batch call. Zod-validated + contradiction-checked by the host;
  // serialization shares the exact code path the preview uses
  // (composeHeadBlock), so both surfaces stay byte-identical.
  const contributions = await plugins.collectContributions(
    seoBundles.map((b) => b.pageId),
    urlArgs,
  );

  // #590 — canonical and sitemap `<loc>` come from the ONE public URL
  // builder plugins also use for hreflang, so they agree byte for byte
  // (host-strategy locales included).
  const publicUrls = new Map(
    await plugins.resolvePublicPageUrls(
      seoBundles.map((b) => ({
        id: b.pageId,
        slug: b.slug,
        currentPath: b.currentPath,
        canonicalOverride: b.canonicalOverride,
      })),
      urlArgs,
    ),
  );
  const publicUrlOf = (b: PageSeoBundle): string => {
    const url = publicUrls.get(b.pageId);
    if (url === undefined) throw new Error(`seo-pass: no public URL resolved for page ${b.pageId}`);
    return url;
  };
  // #1257 — follow-up pages are self-canonical: built from the overview's
  // own public URL, never from a canonical override pointing elsewhere.
  // Resolved as batches meet paginated overviews.
  const ownUrls = new Map<string, string>();
  const followUpUrlOf = (b: PageSeoBundle, n: number): string => {
    const url = ownUrls.get(b.pageId);
    if (url === undefined) throw new Error(`seo-pass: no public URL resolved for page ${b.pageId}`);
    return pagedUrl(url, n, pageUrlStyle);
  };
  // #1142 — breadcrumb pages: every built page, plus trail pages this pass
  // has no bundle for (an incremental build), loaded as batches name them.
  const crumbById = new Map<string, CrumbPage>(seoBundles.map((b) => [b.pageId, b]));
  const crumbTried = new Set<string>();
  const crumbOf = (pageId: string): BreadcrumbJsonLdItem | null => {
    const c = crumbById.get(pageId);
    const url = c ? publicUrls.get(pageId) : undefined;
    return c && url !== undefined ? { name: c.shortTitle, url } : null;
  };
  // #1257 — indexable follow-up pages of each overview, for the sitemap.
  const followUpsOf = new Map<string, number[]>();

  return {
    async apply(pages) {
      const wantCrumbs = new Set<string>();
      for (const p of pages) {
        for (const id of p.breadcrumbTrail ?? []) {
          if (!crumbById.has(id) && !crumbTried.has(id)) wantCrumbs.add(id);
        }
      }
      if (wantCrumbs.size > 0) {
        for (const id of wantCrumbs) crumbTried.add(id);
        const crumbs = await loadCrumbPages(tx, [...wantCrumbs]);
        for (const c of crumbs) crumbById.set(c.pageId, c);
        const urls = await plugins.resolvePublicPageUrls(
          crumbs.map((c) => ({
            id: c.pageId,
            slug: c.slug,
            currentPath: c.currentPath,
            canonicalOverride: c.canonicalOverride,
          })),
          urlArgs,
        );
        for (const [id, url] of urls) publicUrls.set(id, url);
      }
      const paged = [
        ...new Set(pages.filter((p) => p.followUp && !ownUrls.has(p.pageId)).map((p) => p.pageId)),
      ]
        .map((id) => bundleById.get(id))
        .filter((b): b is PageSeoBundle => b !== undefined);
      if (paged.length > 0) {
        const urls = await plugins.resolvePublicPageUrls(
          paged.map((b) => ({
            id: b.pageId,
            slug: b.slug,
            currentPath: b.currentPath,
            canonicalOverride: null,
          })),
          urlArgs,
        );
        for (const [id, url] of urls) ownUrls.set(id, url);
      }

      // #390 — canonical follows the MATERIALIZED composed path; home
      // designation, prefixes, and slug formats are already baked into
      // pages.current_path by the write ops.
      for (const p of pages) {
        const bundle = bundleById.get(p.pageId);
        if (!bundle) continue;
        if (p.followUp?.indexable) {
          followUpsOf.set(p.pageId, [...(followUpsOf.get(p.pageId) ?? []), p.followUp.page]);
        }
        const isNotFoundPage = bundle.pageId === notFoundPageId;
        const ogImageUrl = bundle.ogImageAssetId
          ? (ogImageUrlByAsset.get(bundle.ogImageAssetId) ?? null)
          : null;
        const headBlock = renderSeoHead({
          title: bundle.title,
          metaDescription: bundle.metaDescription,
          ogImageUrl,
          organization: settings.organization,
          ...(isNotFoundPage
            ? notFoundPageSeo()
            : {
                canonical: p.followUp
                  ? followUpUrlOf(bundle, p.followUp.page)
                  : publicUrlOf(bundle),
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
            siteLanguage: settings.siteLanguage,
          }),
        );
      }
    },

    async writeSitemap(write) {
      // sitemap.xml — written for every env (see the file header): staging
      // never references it (its robots.txt has no `Sitemap:` line and the
      // host answers `X-Robots-Tag: noindex`), and promote ships it as-is.
      // #567 — the Owner's toggle gates it; robots.txt follows
      // `sitemapEmitted`, so turning it off also drops the `Sitemap:` line.
      const sitemapEnabled =
        seoBundles.length > 0 && settings.sitemapEnabled && settings.siteBaseUrl.length > 0;
      if (!sitemapEnabled) return false;
      const entries = seoBundles
        .filter((b) => isSitemapEntry(b, notFoundPageId))
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
            ...(followUpsOf.get(b.pageId) ?? [])
              .sort((x, y) => x - y)
              .map((n) => urlEntry(followUpUrlOf(b, n), [])),
          ];
        });
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        ...entries,
        "</urlset>",
        "",
      ].join("\n");
      await write("sitemap.xml", xml);
      return true;
    },
  };
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
async function loadCrumbPages(tx: TransactionRunner, ids: readonly string[]): Promise<CrumbPage[]> {
  if (ids.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS page_id, p.slug, p.current_path, p.short_title,
           s.canonical_url AS canonical_override
    FROM pages p
    LEFT JOIN pages_seo s ON s.page_id = p.id
    WHERE p.id IN (SELECT jsonb_array_elements_text(${jsonb(ids)})::uuid)
      AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
      AND p.status = 'published'
  `)) as unknown as {
    page_id: string;
    slug: string;
    current_path: string;
    short_title: string;
    canonical_override: string | null;
  }[];
  return rows.map((r) => ({
    pageId: r.page_id,
    slug: r.slug,
    currentPath: r.current_path,
    shortTitle: r.short_title,
    canonicalOverride: r.canonical_override,
  }));
}

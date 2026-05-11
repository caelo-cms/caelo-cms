// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 8 — SEO primitives. Per-page SEO is structured fields only;
 * the renderer projects them into <head> meta + canonical + JSON-LD.
 * Per CLAUDE.md §2 "no raw HTML into <head>" — every Zod schema below
 * is on `.strict()` so the AI cannot smuggle additional keys.
 */

import { z } from "zod";

export const CHANGEFREQ_VALUES = [
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
] as const;
export type Changefreq = (typeof CHANGEFREQ_VALUES)[number];

/** Recommended length caps — server enforces, client trims with feedback. */
export const SEO_TITLE_RECOMMENDED_MAX = 60;
export const SEO_DESCRIPTION_RECOMMENDED_MAX = 160;

export const SEO_DESCRIPTION_HARD_MAX = 320;
export const SEO_CANONICAL_MAX = 2048;

export const seoSetInputSchema = z
  .object({
    pageId: z.string().uuid(),
    metaDescription: z.string().max(SEO_DESCRIPTION_HARD_MAX).optional(),
    ogImageAssetId: z.string().uuid().nullable().optional(),
    canonicalUrl: z.string().max(SEO_CANONICAL_MAX).nullable().optional(),
    noindex: z.boolean().optional(),
    changefreq: z.enum(CHANGEFREQ_VALUES).optional(),
    priority: z.number().min(0).max(1).optional(),
  })
  .strict();
export type SeoSetInput = z.infer<typeof seoSetInputSchema>;

export const seoAutofillInputSchema = z
  .object({
    pageId: z.string().uuid(),
    metaDescription: z.string().min(1).max(SEO_DESCRIPTION_HARD_MAX),
    ogImageAssetId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type SeoAutofillInput = z.infer<typeof seoAutofillInputSchema>;

export const seoOptimizeInputSchema = z
  .object({
    pageId: z.string().uuid(),
    metaDescription: z.string().min(1).max(SEO_DESCRIPTION_HARD_MAX),
    ogImageAssetId: z.string().uuid().nullable().optional(),
    /** Optional user-supplied context (keyword research, intent shifts) recorded in audit. */
    context: z.string().max(4000).optional(),
  })
  .strict();
export type SeoOptimizeInput = z.infer<typeof seoOptimizeInputSchema>;

export const siteDefaultsSetSeoInputSchema = z
  .object({
    siteBaseUrl: z
      .string()
      .min(1)
      .max(2048)
      .url("siteBaseUrl must be an absolute URL (https://example.com)"),
    sitemapEnabled: z.boolean(),
    organizationJson: z
      .object({
        name: z.string().max(256).optional(),
        url: z.string().max(2048).optional(),
        logo: z.string().max(2048).optional(),
        sameAs: z.array(z.string().max(2048)).max(20).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type SiteDefaultsSetSeoInput = z.infer<typeof siteDefaultsSetSeoInputSchema>;

export interface PageSeoRow {
  pageId: string;
  metaDescription: string;
  ogImageAssetId: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  changefreq: Changefreq;
  priority: number;
  autofilledAt: string | null;
  optimizedAt: string | null;
  updatedAt: string;
}

export interface SiteSeoSettings {
  siteBaseUrl: string;
  sitemapEnabled: boolean;
  organization: {
    name?: string;
    url?: string;
    logo?: string;
    sameAs?: string[];
  };
}

/**
 * Resolve the canonical URL for a page. If `pages_seo.canonical_url`
 * is set it wins; otherwise build `<siteBaseUrl>/<page-path>` from
 * the page's slug + locale. Locale strategy is single-locale (no
 * prefix) until P9 i18n.
 */
export function resolveCanonicalUrl(args: {
  siteBaseUrl: string;
  pageSlug: string;
  pageLocale: string;
  override: string | null;
  /** P9 — when present, the locale's url_strategy decides the URL shape. */
  localeConfig?: {
    code: string;
    urlStrategy: "none" | "subdirectory" | "subdomain" | "domain";
    urlHost: string | null;
    isDefault: boolean;
  };
  /**
   * v0.2.85 — page emission style. 'directory' (default) → URLs end
   * in `/<slug>/`; 'no-extension' → URLs end in `/<slug>` (no
   * trailing slash) to match what the bucket actually serves when
   * pages are emitted as bare slugs.
   */
  pageUrlStyle?: "directory" | "no-extension";
}): string {
  if (args.override && args.override.length > 0) return args.override;
  const base = args.siteBaseUrl.replace(/\/$/, "");
  const cleanSlug = args.pageSlug === "home" || args.pageSlug === "" ? "" : args.pageSlug;
  const style = args.pageUrlStyle ?? "directory";
  // Tail = the slug portion of the canonical URL, with the trailing
  // shape dictated by the page-emission style. Home pages always
  // resolve to the base URL (no tail) regardless of style.
  const tail = cleanSlug ? (style === "no-extension" ? cleanSlug : `${cleanSlug}/`) : "";
  const cfg = args.localeConfig;
  if (cfg && cfg.urlStrategy !== "none") {
    if (cfg.urlStrategy === "subdirectory") {
      return tail ? `${base}/${cfg.code}/${tail}` : `${base}/${cfg.code}/`;
    }
    if ((cfg.urlStrategy === "subdomain" || cfg.urlStrategy === "domain") && cfg.urlHost) {
      const protocol = base.startsWith("http://") ? "http://" : "https://";
      return tail ? `${protocol}${cfg.urlHost}/${tail}` : `${protocol}${cfg.urlHost}/`;
    }
  }
  return tail ? `${base}/${tail}` : `${base}/`;
}

export interface SeoMetaInput {
  title: string;
  metaDescription: string;
  canonical: string;
  noindex: boolean;
  ogImageUrl: string | null;
  hreflang: { locale: string; url: string }[];
  organization: SiteSeoSettings["organization"];
}

/**
 * Render the <head> meta block for a page. Returns the HTML string
 * the renderer injects just before </head>. Order is canonical
 * (W3C-recommended): charset / viewport stay in the layout; meta
 * description + canonical + robots + Open Graph + Twitter card +
 * hreflang + JSON-LD.
 *
 * No raw HTML escape hatch — every variable is HTML-attribute-encoded.
 */
export function renderSeoHead(input: SeoMetaInput): string {
  const enc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines: string[] = [];
  lines.push(`<title>${enc(input.title)}</title>`);
  if (input.metaDescription) {
    lines.push(`<meta name="description" content="${enc(input.metaDescription)}" />`);
  }
  lines.push(`<link rel="canonical" href="${enc(input.canonical)}" />`);
  if (input.noindex) {
    lines.push(`<meta name="robots" content="noindex" />`);
  }
  // Open Graph
  lines.push(`<meta property="og:title" content="${enc(input.title)}" />`);
  if (input.metaDescription) {
    lines.push(`<meta property="og:description" content="${enc(input.metaDescription)}" />`);
  }
  lines.push(`<meta property="og:type" content="website" />`);
  lines.push(`<meta property="og:url" content="${enc(input.canonical)}" />`);
  if (input.ogImageUrl) {
    lines.push(`<meta property="og:image" content="${enc(input.ogImageUrl)}" />`);
  }
  // Twitter card
  lines.push(
    `<meta name="twitter:card" content="${input.ogImageUrl ? "summary_large_image" : "summary"}" />`,
  );
  // Hreflang per locale + x-default. P8 ships zero rows; P9 i18n
  // populates pages_hreflang and the existing renderer iterates.
  for (const h of input.hreflang) {
    lines.push(`<link rel="alternate" hreflang="${enc(h.locale)}" href="${enc(h.url)}" />`);
  }
  if (input.hreflang.length > 0) {
    lines.push(`<link rel="alternate" hreflang="x-default" href="${enc(input.canonical)}" />`);
  }
  // JSON-LD WebPage block referencing the Organization (when set).
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: input.title,
    url: input.canonical,
  };
  if (input.metaDescription) ld.description = input.metaDescription;
  if (input.ogImageUrl) ld.image = input.ogImageUrl;
  if (input.organization.name) {
    ld.publisher = {
      "@type": "Organization",
      name: input.organization.name,
      ...(input.organization.url ? { url: input.organization.url } : {}),
      ...(input.organization.logo
        ? { logo: { "@type": "ImageObject", url: input.organization.logo } }
        : {}),
      ...(input.organization.sameAs?.length ? { sameAs: input.organization.sameAs } : {}),
    };
  }
  lines.push(
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
  );
  return lines.join("\n");
}

/**
 * Inject `renderSeoHead`'s output just before `</head>`. Replaces any
 * existing `<title>` so the page-level title wins over a layout-
 * supplied default. Pre-existing meta tags from the layout are left
 * alone — authors can still drop e.g. `<meta name="theme-color">` in
 * the layout HTML.
 */
export function injectSeoIntoHead(html: string, headBlock: string): string {
  // Strip a layout-supplied <title> if present; we'll re-emit it in
  // the headBlock at the right position.
  const titleStripped = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, "");
  if (titleStripped.includes("</head>")) {
    return titleStripped.replace("</head>", `${headBlock}\n</head>`);
  }
  // No closing head tag — prepend the block to the document.
  return `${headBlock}\n${titleStripped}`;
}

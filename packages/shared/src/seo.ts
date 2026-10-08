// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 8 — SEO primitives. Per-page SEO is structured fields only;
 * the renderer projects them into <head> meta + canonical + JSON-LD.
 * Per CLAUDE.md §2 "no raw HTML into <head>" — every Zod schema below
 * is on `.strict()` so the AI cannot smuggle additional keys.
 */

import { z } from "zod";
import { trimSlashes } from "./url.js";

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

/** Organization JSON-LD fields — structured only, never raw markup (CLAUDE.md §2). */
const organizationJsonSchema = z
  .object({
    name: z.string().max(256).optional(),
    url: z.string().max(2048).optional(),
    logo: z.string().max(2048).optional(),
    sameAs: z.array(z.string().max(2048)).max(20).optional(),
  })
  .strict();

export const siteDefaultsSetSeoInputSchema = z
  .object({
    siteBaseUrl: z
      .string()
      .min(1)
      .max(2048)
      .url("siteBaseUrl must be an absolute URL (https://example.com)"),
    sitemapEnabled: z.boolean(),
    organizationJson: organizationJsonSchema.default({}),
  })
  .strict();
export type SiteDefaultsSetSeoInput = z.infer<typeof siteDefaultsSetSeoInputSchema>;

/**
 * Input of `site_defaults.propose_set_seo` — the AI's path to the site SEO
 * settings (CLAUDE.md §11.A). Every field is optional so the AI changes only
 * what the operator asked for; an omitted field keeps its stored value when
 * the Owner approves. `organizationJson` replaces the whole object.
 */
export const siteSeoProposalInputSchema = z
  .object({
    siteBaseUrl: z.string().min(1).max(2048).optional(),
    sitemapEnabled: z.boolean().optional(),
    organizationJson: organizationJsonSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.siteBaseUrl !== undefined ||
      v.sitemapEnabled !== undefined ||
      v.organizationJson !== undefined,
    "pass at least one of `siteBaseUrl`, `sitemapEnabled`, `organizationJson`",
  );
export type SiteSeoProposalInput = z.infer<typeof siteSeoProposalInputSchema>;

/** Result of {@link checkPublicSiteBaseUrl}. */
export type PublicSiteBaseUrlCheck = { ok: true; url: string } | { ok: false; message: string };

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Wildcard bind addresses: a server listens on them, no browser can visit them. */
const WILDCARD_HOST = /^(0\.0\.0\.0|\[::\])$/;

/**
 * Validate a public site base URL and normalise it to its origin
 * (`https://example.com`, no trailing slash).
 *
 * Every canonical, og:url, JSON-LD url, hreflang target and sitemap entry is
 * `<base><path>`, so the base must be exactly the origin visitors reach: no
 * path, query, fragment or credentials. On a cloud install (`provider` is a
 * `CAELO_PROVIDER` other than self-hosted) it must be https and not a
 * loopback host — a localhost base there ships unreachable canonicals to
 * production. A self-hosted install may use `http://localhost:<port>`, the
 * documented local-dev value; any other host still needs https.
 *
 * @param provider - `CAELO_PROVIDER` of the install; `undefined`/`""`/`"self-hosted"` = self-hosted.
 */
export function checkPublicSiteBaseUrl(
  raw: string,
  provider: string | undefined,
): PublicSiteBaseUrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return {
      ok: false,
      message: `"${raw}" is not an absolute URL — pass the public origin, e.g. https://www.example.com`,
    };
  }
  const origin = `${u.protocol}//${u.host}`;
  if (u.username || u.password) {
    return { ok: false, message: "the site URL must not contain credentials" };
  }
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    return {
      ok: false,
      message: `the site URL must be the origin only, without path, query or fragment — use ${origin}`,
    };
  }
  if (WILDCARD_HOST.test(u.hostname)) {
    return {
      ok: false,
      message: `${u.hostname} is a bind address, not an address visitors can open — use the public domain (e.g. https://www.example.com) or, on a local self-hosted install, http://localhost:<port>`,
    };
  }
  const selfHosted = !provider || provider === "self-hosted";
  const loopback = LOOPBACK_HOST.test(u.hostname);
  if (loopback && !selfHosted) {
    return {
      ok: false,
      message: `${origin} is a local address; on this ${provider} install the site URL must be the public domain visitors use (e.g. https://www.example.com)`,
    };
  }
  if (u.protocol !== "https:" && !(selfHosted && loopback && u.protocol === "http:")) {
    return {
      ok: false,
      message: `the site URL must use https (got ${u.protocol.replace(":", "")}) — use https://${u.host}`,
    };
  }
  return { ok: true, url: origin };
}

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
  /** `site_defaults.site_language` — the `<html lang>` of every page no
   *  plugin assigns its own locale to (see document-language.ts). Always
   *  set here: the static generator refuses to build while it is NULL. */
  siteLanguage: string;
  organization: {
    name?: string;
    url?: string;
    logo?: string;
    sameAs?: string[];
  };
}

/**
 * How a deploy target serves pages (`deploy_targets.page_url_style`):
 * 'directory' emits `<path>/index.html` and serves `/<path>/`;
 * 'no-extension' emits a bare `<path>` file and serves `/<path>`.
 */
export const PAGE_URL_STYLES = ["directory", "no-extension"] as const;
export type PageUrlStyle = (typeof PAGE_URL_STYLES)[number];

/**
 * THE public page URL builder (#590). Every absolute page URL Caelo
 * emits — canonical, og:url, JSON-LD url, sitemap `<loc>`,
 * hreflang/x-default targets, language-switcher links — comes from
 * here, so they are byte-identical by construction. Two builders
 * drifting apart is what shipped `/en/about` as hreflang next to an
 * `/en/about/` canonical.
 *
 * `pages_seo.canonical_url` (`override`) wins when set. Otherwise the
 * URL is `<scheme>//<host><path>`: the path is the COMPOSED public path
 * from `pages.current_path` (#390), its trailing slash follows the
 * serving target's {@link PageUrlStyle}, the host is the URL composition
 * point's `host` slot (a host-strategy locale) or else the site base
 * URL's, and the scheme always comes from the base URL.
 */
export function resolveCanonicalUrl(args: {
  siteBaseUrl: string;
  /** The page's composed path (`pages.current_path`): leading slash,
   *  "/" for the site root. */
  pagePath: string;
  override: string | null;
  /** The serving deploy target's page emission style. Required — a
   *  defaulted style is how the preview drifted from the build. */
  pageUrlStyle: PageUrlStyle;
  /** Host from the URL composition point's `host` slot (e.g.
   *  `de.example.com`); null/absent → the site base URL's host. */
  host?: string | null;
}): string {
  if (args.override && args.override.length > 0) return args.override;
  const siteBase = args.siteBaseUrl.endsWith("/")
    ? args.siteBaseUrl.slice(0, -1)
    : args.siteBaseUrl;
  const base = args.host ? `${new URL(siteBase).protocol}//${args.host}` : siteBase;
  const trimmed = trimSlashes(args.pagePath);
  if (trimmed.length === 0) return `${base}/`;
  return args.pageUrlStyle === "no-extension" ? `${base}/${trimmed}` : `${base}/${trimmed}/`;
}

export interface SeoMetaInput {
  title: string;
  metaDescription: string;
  /**
   * Absolute canonical URL, or null when the site base URL is not
   * configured yet (#551). Only the admin preview renders with null — it
   * omits canonical, og:url and the JSON-LD url and flags
   * `site-base-url-unset`; the static generator refuses to build instead.
   */
  canonical: string | null;
  noindex: boolean;
  ogImageUrl: string | null;
  organization: SiteSeoSettings["organization"];
}

/**
 * Render the <head> meta block for a page. Returns the HTML string
 * the renderer injects just before </head>. Order is canonical
 * (W3C-recommended): charset / viewport stay in the layout; meta
 * description + canonical + robots + Open Graph + Twitter card +
 * JSON-LD.
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
  if (input.canonical) {
    lines.push(`<link rel="canonical" href="${enc(input.canonical)}" />`);
  }
  if (input.noindex) {
    lines.push(`<meta name="robots" content="noindex" />`);
  }
  // Open Graph
  lines.push(`<meta property="og:title" content="${enc(input.title)}" />`);
  if (input.metaDescription) {
    lines.push(`<meta property="og:description" content="${enc(input.metaDescription)}" />`);
  }
  lines.push(`<meta property="og:type" content="website" />`);
  if (input.canonical) {
    lines.push(`<meta property="og:url" content="${enc(input.canonical)}" />`);
  }
  if (input.ogImageUrl) {
    lines.push(`<meta property="og:image" content="${enc(input.ogImageUrl)}" />`);
  }
  // Twitter card
  lines.push(
    `<meta name="twitter:card" content="${input.ogImageUrl ? "summary_large_image" : "summary"}" />`,
  );
  // JSON-LD WebPage block referencing the Organization (when set).
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: input.title,
    ...(input.canonical ? { url: input.canonical } : {}),
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

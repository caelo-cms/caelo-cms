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
 * Env var through which the provisioner declares an install's public
 * site URL (`https://<domain>`). Set on the admin service by every
 * provisioning stack that knows the domain, and by `cms-provision
 * upgrade` for installs provisioned before it existed. The admin seeds
 * `site_defaults.site_base_url` from it (`siteBaseUrlToSeed`); it is
 * never read as a render-time fallback.
 */
export const SITE_BASE_URL_ENV = "CAELO_SITE_BASE_URL";

/**
 * True when `url` points at the local machine (localhost, `*.localhost`,
 * 127.0.0.0/8, ::1, 0.0.0.0). Such a base URL is only meaningful on a
 * dev box — `site_defaults.site_base_url` ships with the dev value
 * `http://localhost:8082` (migration 0027) — and must never reach a
 * public site's canonical / og:url / sitemap.
 *
 * @returns false for a string that is not an absolute URL; callers that
 *   need a valid URL validate it separately.
 */
export function isLoopbackBaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "0.0.0.0") return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Decide whether the admin should seed `site_defaults.site_base_url`
 * from the provisioner-declared public URL. Seeds only while the stored
 * value is still a local address (the migration's dev default, or any
 * other loopback URL) — an operator-chosen public URL is never
 * overwritten.
 *
 * @param stored   the current `site_defaults.site_base_url`.
 * @param declared the `CAELO_SITE_BASE_URL` value, if the install has one.
 * @returns the URL to write, or null when nothing should change.
 */
export function siteBaseUrlToSeed(stored: string, declared: string | undefined): string | null {
  const next = declared?.trim();
  if (!next || !isAbsoluteHttpUrl(next) || isLoopbackBaseUrl(next)) return null;
  if (!isLoopbackBaseUrl(stored)) return null;
  return next;
}

const CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["gcp", "gcp-firebase", "aws", "azure"]);

/**
 * Guard for every static build: a site whose base URL is still a local
 * address would ship canonical, og:url, JSON-LD `url`, sitemap `<loc>`
 * and the robots.txt `Sitemap:` line pointing at localhost. That is
 * fatal for a public install — which a build is when it runs on a cloud
 * provider, or when the provisioner declared a public URL for the
 * install. A local dev box (no provider, no declared URL) keeps building
 * against `http://localhost:8082`.
 *
 * Applies to staging builds too: production either rebuilds or promotes
 * the staged build byte-for-byte, so the staged canonical IS the
 * production canonical.
 *
 * @returns the error message to throw, or null when the build may proceed.
 */
export function localSiteBaseUrlError(args: {
  siteBaseUrl: string;
  /** `CAELO_PROVIDER` of the running install. */
  provider: string | undefined;
  /** `CAELO_SITE_BASE_URL` of the running install. */
  declaredSiteBaseUrl: string | undefined;
}): string | null {
  if (!isLoopbackBaseUrl(args.siteBaseUrl)) return null;
  const declared = args.declaredSiteBaseUrl?.trim();
  const declaredPublic = !!declared && !isLoopbackBaseUrl(declared);
  const isCloud = args.provider !== undefined && CLOUD_PROVIDERS.has(args.provider);
  if (!isCloud && !declaredPublic) return null;
  return (
    `site base URL is '${args.siteBaseUrl}', a local address — canonical links, og:url, JSON-LD, sitemap.xml and robots.txt would all point at it on the public site. ` +
    "Set the public site URL (e.g. https://example.com) at Security → SEO (op `site_defaults.set_seo`), " +
    (declaredPublic
      ? `or restart the admin so it adopts the provisioned ${SITE_BASE_URL_ENV}=${declared}, `
      : `or run \`cms-provision upgrade\`, which sets ${SITE_BASE_URL_ENV} from the install's domain, `) +
    "then re-run the deploy."
  );
}

/**
 * Resolve the canonical URL for a page. If `pages_seo.canonical_url`
 * is set it wins; otherwise `<siteBaseUrl><pagePath>` — where
 * `pagePath` is the COMPOSED public path from `pages.current_path`
 * (#390: the URL composition point materializes prefixes, slug
 * formats, and the home designation into that one column; canonical
 * simply follows it).
 */
export function resolveCanonicalUrl(args: {
  siteBaseUrl: string;
  /** The page's composed path (`pages.current_path`): leading slash,
   *  "/" for the site root. */
  pagePath: string;
  override: string | null;
  /**
   * v0.2.85 — page emission style. 'directory' (default) → URLs end
   * in `/…/`; 'no-extension' → no trailing slash, matching what the
   * bucket serves when pages are emitted as bare files.
   */
  pageUrlStyle?: "directory" | "no-extension";
}): string {
  if (args.override && args.override.length > 0) return args.override;
  const base = args.siteBaseUrl.endsWith("/") ? args.siteBaseUrl.slice(0, -1) : args.siteBaseUrl;
  const trimmed = trimSlashes(args.pagePath);
  if (trimmed.length === 0) return `${base}/`;
  const style = args.pageUrlStyle ?? "directory";
  return style === "no-extension" ? `${base}/${trimmed}` : `${base}/${trimmed}/`;
}

export interface SeoMetaInput {
  title: string;
  metaDescription: string;
  canonical: string;
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

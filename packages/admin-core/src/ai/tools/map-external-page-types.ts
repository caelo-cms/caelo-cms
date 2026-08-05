// SPDX-License-Identifier: MPL-2.0

/**
 * issue #278 — `map_external_page_types`: turn a site's HOMEPAGE into its
 * page-type map. Run #11 crawled 357 archive/tag/date/author URLs for a
 * "migrate searchviu.com/en" request and stalled; the fix is to read the
 * homepage's nav + footer links (plus a sitemap sample as backstop),
 * group them into the site's REAL types — pricing, blog-article,
 * use-cases — with one representative sample URL each, and drop the noise
 * BEFORE any crawl. The AI names each type to the operator from the
 * supplied evidence and picks which to rebuild.
 *
 * Sources: homepage nav + footer links (via the same extractor as
 * `inspect_external_page`'s `links` facet) + a sampled sitemap.xml. All
 * fetches go through the SSRF-guarded `safeExternalFetch` (#191); the
 * sitemap is SAMPLED, never enumerated to thousands.
 */

import {
  classifyPageTypes,
  discoverSitemapUrls,
  extractOutboundLinks,
  fetchRenderedHtml,
  safeExternalFetch,
  type TextFetcher,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { externalFetchAllowedHosts, takeExternalFetchBudget } from "./_external-fetch-budget.js";
import { getExternalScreenshotter } from "./_external-screenshotter.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z
  .object({
    url: z.string().url(),
    includeSitemap: z.boolean().optional(),
    sitemapSampleSize: z.number().int().min(1).max(200).optional(),
    /** issue #425 — only URLs under this path prefix become types/
     *  samples; the rest are reported as out-of-scope noise. */
    scopePathPrefix: z
      .string()
      .min(1)
      .max(300)
      .regex(/^\//, "scopePathPrefix must start with '/' (a URL path prefix like /de/)")
      .optional(),
  })
  .strict();
type Input = z.infer<typeof input>;

const DEFAULT_SITEMAP_SAMPLE = 40;
const SITEMAP_BYTE_CAP = 512 * 1024;

export const mapExternalPageTypesTool: ToolDefinitionWithHandler<Input> = {
  name: "map_external_page_types",
  description:
    "Turn an EXTERNAL site's HOMEPAGE into its page-type map: the distinct page types it exposes (pricing, blog-article, use-cases, …), each with ONE representative sample URL to build a template from, plus WHY it was classified so you can name it to the operator. " +
    "Use this in migration step 1 (understand structure) right after glancing the homepage — it is the cheap alternative to crawling the whole origin. Sources: homepage nav + footer links + a sampled sitemap.xml. " +
    "It FILTERS noise automatically: other-locale prefixes (/de when you migrate /en), /tag, /category, date archives (/2023/05/…), /author, and pagination — those never become types. Many /blog/* collapse into ONE 'blog-article' type with one sample. " +
    'Pass the exact base you are migrating (e.g. https://example.com/en) so the active locale is scoped correctly. When the operator asked for one language/section of the site, ALSO pass `scopePathPrefix` (e.g. "/de/") — samples then come only from inside that scope and everything else is reported as out-of-scope, never sampled (issue #425). Then sample each returned type with `inspect_external_page` and build its template. ' +
    "Do NOT crawl the whole site (`propose_site_import`) before this — that is what #278 removes. Only public http(s) URLs; private addresses are refused.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description:
          "The homepage / base URL being migrated, e.g. https://example.com/en — fixes the host + active locale.",
      },
      includeSitemap: {
        type: "boolean",
        description:
          "Also sample sitemap.xml as a backstop for types the nav/footer miss. Default true.",
      },
      sitemapSampleSize: {
        type: "number",
        description: "How many sitemap URLs to sample (not enumerate). Default 40, max 200.",
      },
      scopePathPrefix: {
        type: "string",
        description:
          'issue #425 — path prefix ("/de/") when the operator migrates one language/section: only URLs under it become types/samples; the rest are reported as out-of-scope.',
      },
    },
  },
  handler: async (_ctx, toolInput, toolCtx) => {
    const budget = takeExternalFetchBudget(toolCtx.chatSessionId);
    if (!budget.ok) {
      return {
        ok: false,
        content:
          "External-fetch budget exhausted for this session (12 per 10 minutes). Wait for the window to roll over, then map the page types again.",
      };
    }
    const allowedHosts = externalFetchAllowedHosts();

    // Render-first: a site's primary nav/footer is often JS-built, so the
    // page-type map must read the rendered DOM, not the pre-JS source. Falls
    // back to a static fetch (with a note) when Chromium is unavailable.
    const screenshotter = await getExternalScreenshotter({ allowedHosts });
    const rf = await fetchRenderedHtml(toolInput.url, {
      screenshotter,
      allowedHosts,
      maxBytes: 2 * 1024 * 1024,
    });
    if (!rf.ok) {
      return {
        ok: false,
        content: rf.blocked
          ? rf.message
          : `map_external_page_types: ${toolInput.url} — ${rf.message}. Verify the address with the operator.`,
      };
    }

    const links = extractOutboundLinks(rf.html, rf.finalUrl);

    let sitemapUrls: string[] = [];
    let sitemapNote = "sitemap not sampled";
    if (toolInput.includeSitemap ?? true) {
      const sampleSize = toolInput.sitemapSampleSize ?? DEFAULT_SITEMAP_SAMPLE;
      const fetcher: TextFetcher = async (u) => {
        try {
          const r = await safeExternalFetch(u, { allowedHosts, maxBytes: SITEMAP_BYTE_CAP });
          return { ok: r.ok, body: r.bodyText, contentType: r.contentType };
        } catch {
          return { ok: false, body: "", contentType: "" };
        }
      };
      try {
        const discovery = await discoverSitemapUrls({
          origin: new URL(rf.finalUrl).origin,
          fetcher,
          maxUrls: sampleSize,
        });
        sitemapUrls = [...discovery.urls];
        sitemapNote =
          discovery.urls.length > 0
            ? `sampled ${discovery.urls.length} sitemap URL(s)${discovery.truncated ? " (truncated — site is larger)" : ""}`
            : "no sitemap.xml found";
      } catch {
        sitemapNote = "sitemap sampling failed (best-effort — nav/footer still classified)";
      }
    }

    const map = classifyPageTypes({
      siteUrl: rf.finalUrl,
      links,
      sitemapUrls,
      ...(toolInput.scopePathPrefix !== undefined
        ? { scopePathPrefix: toolInput.scopePathPrefix }
        : {}),
    });

    if (map.types.length === 0) {
      return {
        ok: true,
        content: `# Page-type map — ${rf.finalUrl}\n\nNo page types found in the homepage nav/footer or sitemap sample (${sitemapNote}). The nav is now read from the RENDERED DOM, so if it's still empty the menu may only build on interaction (a hamburger that expands on click) or the site keys navigation off something other than links — inspect the homepage (\`{screenshot:true}\`) or ask the operator which sections the site has.`,
      };
    }

    // issue #425 — the scope is stated loudly, with the out-of-scope
    // count, so a scoped sampling pass is auditable at a glance.
    const outOfScopeCount = map.filtered.filter((f) => f.reason.startsWith("out-of-scope")).length;
    const lines: string[] = [
      `# Page-type map — ${rf.finalUrl}`,
      map.activeLocale ? `Active locale: /${map.activeLocale}` : "No locale prefix on this URL.",
      map.scopePathPrefix !== ""
        ? `Scope: only ${map.scopePathPrefix}/ — ${outOfScopeCount} out-of-scope URL(s) filtered (listed below).`
        : "Scope: none (whole site considered).",
      `Sitemap: ${sitemapNote}.`,
      "",
      "## Page types (ordered by importance — build templates for these)",
    ];
    map.types.forEach((t, i) => {
      lines.push(
        `${i + 1}. type="${t.type}" [${t.source}${t.collection ? `, collection ×${t.memberCount}` : ""}]`,
        `   sample: ${t.sampleUrl}`,
        `   why: ${t.evidence}`,
      );
    });
    if (map.filtered.length > 0) {
      lines.push(
        "",
        `## Filtered as noise (${map.filtered.length}) — NOT page types`,
        ...map.filtered.slice(0, 20).map((x) => `- ${x.url} (${x.reason})`),
        map.filtered.length > 20 ? `- …and ${map.filtered.length - 20} more` : "",
      );
    }
    lines.push(
      "",
      "Next: sample each type's URL with `inspect_external_page` ({screenshot, tokens, altTexts, images}) and build its template.",
      `(${budget.remaining} external fetches left in this session's budget.)`,
    );

    return { ok: true, content: lines.filter((s) => s !== "").join("\n") };
  },
};

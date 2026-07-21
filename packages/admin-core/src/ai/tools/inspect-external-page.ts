// SPDX-License-Identifier: MPL-2.0

/**
 * issue #189 / #278 — `inspect_external_page`: fetch ONE external page
 * (SSRF-guarded, #191) and return ONLY the FACETS the current migration
 * step needs. The homepage-driven flow (issue #278) understands a site's
 * structure cheaply (a discovery turn asks for `links` + `meta` only),
 * then samples one page per type richly (screenshot + tokens + altTexts,
 * plus Markdown for the content). A single heavyweight blob on every call
 * is exactly what #278 removes.
 *
 * There is NO raw-markup facet: understanding a page is `markdown` (its
 * readable text), and pulling specific structure is `query_page_html`
 * (bounded, by selector or a small-model `describe`). A full HTML dump was
 * pure context bloat — a single rich one ran to ~380K tokens — and the
 * migration flow authors fresh modules anyway, so the legacy markup is not
 * worth carrying.
 *
 * Facets (all boolean switches; default when none given: meta + markdown
 * — the gist; every voluminous facet is opt-in):
 *   - meta       — title, description, canonical, lang + hreflang, h1–h3.
 *   - markdown   — the page's readable text as Markdown (the gist). Cached
 *                  under a pageRef; truncated with a cursor (read_page_more).
 *   - links      — outbound links (href, anchor text, rel, nav|footer|body).
 *                  OPT-IN (default off): 200+-link pages otherwise bloat
 *                  every call; enable it on the first/homepage inspect.
 *   - altTexts   — img alt / aria-label inventory.
 *   - screenshot — rendered viewport image (attached to the next turn).
 *   - tokens     — design fact base: static CSS-derived inventory + the
 *                  WS1 computed-style sampler (when Playwright is present).
 */

import { formatGenesisInventory, inventoryGenesisDraft } from "@caelo-cms/shared";
import {
  deriveDesignTokens,
  extractAltTexts,
  extractOutboundLinks,
  extractPageMeta,
  htmlToMarkdown,
  isExternalUrlBlockedError,
  type OutboundLink,
  type SafeFetchResponse,
  safeExternalFetch,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { externalFetchAllowedHosts, takeExternalFetchBudget } from "./_external-fetch-budget.js";
import { getExternalScreenshotter } from "./_external-screenshotter.js";
import { putPageInspection, sliceMarkdown } from "./_page-inspection-cache.js";
import type { ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";

const facets = z
  .object({
    links: z.boolean().optional(),
    markdown: z.boolean().optional(),
    screenshot: z.boolean().optional(),
    altTexts: z.boolean().optional(),
    meta: z.boolean().optional(),
    tokens: z.boolean().optional(),
  })
  .strict();

const input = z.object({ url: z.string().url(), facets: facets.optional() }).strict();
type Input = z.infer<typeof input>;

interface ResolvedFacets {
  links: boolean;
  markdown: boolean;
  screenshot: boolean;
  altTexts: boolean;
  meta: boolean;
  tokens: boolean;
}

/**
 * Minimal core when the caller names no facets: `meta` only.
 *
 * `links` is opt-in (default OFF). A nav / footer / blog-index page can
 * carry 200+ links, which bloats the context on EVERY inspect — but the
 * full inventory is usually needed only once (the first / homepage
 * inspect, for site-structure discovery). The skill guidance switches
 * `links: true` on that first inspect and leaves it off for the rest, so
 * flipping the no-facets default costs the discovery flow nothing (it
 * passes `links: true` explicitly).
 */
function resolveFacets(raw: Input["facets"]): ResolvedFacets {
  const any =
    raw !== undefined &&
    (raw.links || raw.markdown || raw.screenshot || raw.altTexts || raw.meta || raw.tokens);
  // Gist default (no facets named): meta + Markdown — "what's on the page,
  // how is it laid out" in the smallest context. Everything voluminous
  // (links, screenshot, tokens) stays opt-in. There is no raw-markup facet
  // any more: read the page as Markdown, and pull specific structure with
  // `query_page_html` (bounded) — a full HTML dump was pure context bloat.
  if (!any)
    return {
      meta: true,
      markdown: true,
      links: false,
      screenshot: false,
      altTexts: false,
      tokens: false,
    };
  return {
    links: raw?.links ?? false,
    markdown: raw?.markdown ?? false,
    screenshot: raw?.screenshot ?? false,
    altTexts: raw?.altTexts ?? false,
    meta: raw?.meta ?? false,
    tokens: raw?.tokens ?? false,
  };
}

const MAX_STYLESHEETS = 3;
const STYLESHEET_BYTE_CAP = 512 * 1024;
const LINKS_PER_LOCATION = 60;

/** Linear scan for same-host `<link rel=stylesheet href>` URLs (capped),
 *  so the static design inventory sees the real palette (external sites
 *  keep CSS in files). Cross-origin CSS is skipped — the glance never
 *  fans out across origins. */
export function extractStylesheetHrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let from = 0;
  while (out.length < 12) {
    const open = lower.indexOf("<link", from);
    if (open === -1) break;
    const close = lower.indexOf(">", open);
    if (close === -1) break;
    const tag = html.slice(open, close + 1);
    from = close + 1;
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.host === new URL(baseUrl).host) out.push(abs.toString());
    } catch {
      // unparseable href — skip
    }
  }
  return out.slice(0, MAX_STYLESHEETS);
}

function formatLinks(links: readonly OutboundLink[]): string {
  const groups: Array<[OutboundLink["location"], string]> = [
    ["nav", "Nav"],
    ["footer", "Footer"],
    ["body", "Body"],
  ];
  const lines: string[] = [];
  for (const [loc, label] of groups) {
    const inLoc = links.filter((l) => l.location === loc).slice(0, LINKS_PER_LOCATION);
    if (inLoc.length === 0) continue;
    lines.push(`### ${label} links (${inLoc.length})`);
    for (const l of inLoc) {
      const rel = l.rel ? ` rel="${l.rel}"` : "";
      lines.push(`- ${l.text ? `"${l.text}" → ` : ""}${l.href}${rel}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no outbound links found)";
}

/** Inline same-host stylesheets, then run the genesis inventory — the
 *  static, browser-free half of the `tokens` facet. Per-sheet failures
 *  are non-fatal + noted (a thin palette must be explainable). */
async function staticDesignFactBase(
  html: string,
  finalUrl: string,
  allowedHosts: readonly string[],
): Promise<string> {
  const sheetUrls = extractStylesheetHrefs(html, finalUrl);
  const notes: string[] = [];
  let css = "";
  for (const sheetUrl of sheetUrls) {
    try {
      const sheet = await safeExternalFetch(sheetUrl, {
        allowedHosts,
        maxBytes: STYLESHEET_BYTE_CAP,
      });
      if (sheet.ok) css += `\n<style>${sheet.bodyText}</style>`;
      else notes.push(`stylesheet ${sheetUrl} answered HTTP ${sheet.status}`);
    } catch (e) {
      notes.push(`stylesheet ${sheetUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const inventory = formatGenesisInventory(inventoryGenesisDraft(html + css));
  return notes.length > 0 ? `${inventory}\nStylesheet notes: ${notes.join("; ")}` : inventory;
}

export const inspectExternalPageTool: ToolDefinitionWithHandler<Input> = {
  name: "inspect_external_page",
  description:
    "Fetch ONE page of an EXTERNAL website (the operator's existing site, a reference site) and return ONLY the facets you ask for — keep discovery turns small, template-building turns rich. " +
    "Pass `facets` (booleans; default when omitted = meta + markdown — the gist; every voluminous facet is opt-in): " +
    "`markdown` (the page's readable text as Markdown — use this to understand what a page is about + how it's laid out; truncated with a cursor, call read_page_more for the rest), " +
    "`meta` (title, description, canonical, lang+hreflang, h1–h3 outline), " +
    "`links` (outbound links with anchor text, rel, and nav|footer|body location — the raw material for the page-type map; OPT-IN, default off, since index/nav pages can carry 200+ links — enable it on the FIRST/homepage inspect for site-structure discovery, leave off for content inspects), " +
    "`altTexts` (img alt / aria-label inventory), " +
    "`screenshot` (rendered viewport image on your next turn), " +
    "`tokens` (design fact base: CSS-derived color/font inventory + rendered computed-style tokens). " +
    "There is NO raw-HTML/markup facet: for specific structure use `query_page_html` (by selector or a natural-language `describe`), which is bounded — never dump a whole page's HTML into the chat. " +
    "Step 1 understand a page → default (`{}` = meta + markdown) + `{links:true}` on the FIRST/homepage inspect for site structure. Step 3 build a template from a sample → `{screenshot:true, tokens:true, altTexts:true}` for the visual + design + images, markdown for the content, and `query_page_html` for any specific section. " +
    "To turn a homepage's links into the site's page-type map, use `map_external_page_types` instead. " +
    "Do NOT use for whole-site work (no link-following) — use `propose_site_import`. Do NOT use on Caelo's own pages — use `inspect_page_render`. " +
    "Only public http(s) URLs work; private/internal addresses are refused by the SSRF guard.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "Absolute public URL, e.g. https://example.com/" },
      facets: {
        type: "object",
        additionalProperties: false,
        description:
          "Which facets to pull. Omit for the gist (meta + markdown). Each is a boolean switch; voluminous facets (links, screenshot, tokens) are opt-in.",
        properties: {
          markdown: {
            type: "boolean",
            description:
              "The page's readable text as Markdown (headings, paragraphs, links, lists) — the gist for understanding a page. For specific structure use query_page_html, not a raw-HTML dump. Truncated to one slice with a cursor; call read_page_more for the rest.",
          },
          meta: {
            type: "boolean",
            description:
              "Title, meta description, canonical, lang + hreflang alternates, h1–h3 outline.",
          },
          links: {
            type: "boolean",
            description:
              "OPT-IN (default off). Outbound links: {href (absolute), text (anchor text), rel, location: nav|footer|body}. Enable on the first/homepage inspect for site-structure discovery; index/nav pages can carry 200+ links, so leave it off for content inspects.",
          },
          altTexts: { type: "boolean", description: "img alt / aria-label inventory." },
          screenshot: {
            type: "boolean",
            description: "Rendered viewport image, attached to your next turn (needs Playwright).",
          },
          tokens: {
            type: "boolean",
            description:
              "Design fact base: static CSS-derived inventory + computed-style design tokens (WS1 sampler, needs Playwright).",
          },
        },
      },
    },
  },
  handler: async (_ctx, toolInput, toolCtx) => {
    const budget = takeExternalFetchBudget(toolCtx.chatSessionId);
    if (!budget.ok) {
      return {
        ok: false,
        content:
          "External-fetch budget exhausted for this session (12 per 10 minutes). This tool is for a one-page glance — if you need many pages, propose the crawl via `propose_site_import` instead.",
      };
    }
    const f = resolveFacets(toolInput.facets);
    const allowedHosts = externalFetchAllowedHosts();
    const needHtml = f.links || f.markdown || f.altTexts || f.meta || f.tokens;

    let res: SafeFetchResponse | null = null;
    if (needHtml) {
      try {
        res = await safeExternalFetch(toolInput.url, { allowedHosts, maxBytes: 2 * 1024 * 1024 });
      } catch (e) {
        if (isExternalUrlBlockedError(e)) return { ok: false, content: e.message };
        return {
          ok: false,
          content: `inspect_external_page could not fetch ${toolInput.url}: ${e instanceof Error ? e.message : String(e)}. If the site is up, tell the operator what you tried and ask them to verify the address.`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          content: `inspect_external_page: ${toolInput.url} answered HTTP ${res.status}. Verify the address with the operator.`,
        };
      }
      if (!res.contentType.includes("text/html")) {
        return {
          ok: false,
          content: `inspect_external_page: ${toolInput.url} is ${res.contentType || "an unknown content type"}, not an HTML page.`,
        };
      }
    }

    const finalUrl = res?.finalUrl ?? toolInput.url;
    const html = res?.bodyText ?? "";
    const enabled = Object.entries(f)
      .filter(([, on]) => on)
      .map(([name]) => name);
    const sections: string[] = [
      `# External page inspection — ${finalUrl}`,
      `Facets: ${enabled.join(", ")}`,
      "",
    ];

    if (f.meta) {
      const meta = extractPageMeta(html, finalUrl);
      const hreflang =
        meta.hreflangAlternates.length > 0
          ? meta.hreflangAlternates.map((a) => `${a.hreflang} → ${a.href}`).join(", ")
          : "(none)";
      sections.push(
        "## Meta",
        `Title: ${meta.title || "(none)"}`,
        meta.metaDescription
          ? `Meta description: ${meta.metaDescription}`
          : "Meta description: (none)",
        `Lang: ${meta.lang || "(none)"}`,
        `Canonical: ${meta.canonical || "(none)"}`,
        `Hreflang alternates: ${hreflang}`,
        "Headings outline:",
        meta.headings.length > 0 ? meta.headings.join("\n") : "(no h1–h3 headings)",
        "",
      );
    }

    // The gist facet: readable page text as Markdown (far smaller than raw
    // markup). Truncated to one slice with a cursor; call `read_page_more`
    // with the pageRef + cursor for the rest.
    let fullMarkdown: string | null = null;
    if (f.markdown) {
      fullMarkdown = htmlToMarkdown(html);
      const { text, nextCursor } = sliceMarkdown(fullMarkdown, 0);
      sections.push(
        "## Page text (Markdown)",
        text.length > 0 ? text : "(no readable text extracted)",
        nextCursor !== null
          ? `\n[truncated — ${fullMarkdown.length - text.length} more chars. Call read_page_more({ pageRef, cursor: ${nextCursor} }) for the rest.]`
          : "",
        "",
      );
    }

    if (f.links) {
      sections.push("## Outbound links", formatLinks(extractOutboundLinks(html, finalUrl)), "");
    }

    if (f.altTexts) {
      const alts = extractAltTexts(html, finalUrl);
      const lines = alts.map((a) =>
        a.kind === "img-alt"
          ? `- img alt="${a.text}"${a.src ? ` (${a.src})` : ""}`
          : `- aria-label="${a.text}"`,
      );
      sections.push(
        "## Alt-text inventory",
        lines.length > 0 ? lines.join("\n") : "(no img alt / aria-label attributes found)",
        "",
      );
    }

    if (f.tokens) {
      sections.push(
        "## Design fact base (static, CSS-derived)",
        await staticDesignFactBase(html, finalUrl, allowedHosts),
        "",
      );
    }

    // One render pass covers both the screenshot + the computed-style
    // tokens so a rich template-building turn renders the page ONCE.
    let image: ToolResult["image"];
    // Captured during the render (page.content()) so the pageRef cache can
    // hold the JS-applied DOM for query_page_html's selectors.
    let renderedHtml: string | undefined;
    if (f.screenshot || f.tokens) {
      const screenshotter = await getExternalScreenshotter({ allowedHosts });
      if (!screenshotter) {
        const want = [f.screenshot ? "screenshot" : "", f.tokens ? "computed-style tokens" : ""]
          .filter(Boolean)
          .join(" + ");
        sections.push(
          `## Rendered facets UNAVAILABLE (${want})`,
          "Playwright/Chromium is not installed in this runtime (`bun node_modules/playwright/cli.js install chromium` fixes it on self-hosted installs). Do NOT claim you saw the page. The non-rendered facets above are still valid.",
          "",
        );
      } else {
        try {
          const shot = await screenshotter.capture(toolInput.url, {
            width: 1280,
            height: 800,
            external: true,
            fullPage: false,
            sampleStyles: f.tokens,
            captureHtml: true,
          });
          renderedHtml = shot.renderedHtml;
          if (f.tokens && shot.styleSamples) {
            sections.push(
              "## Computed-style design tokens (rendered)",
              JSON.stringify(deriveDesignTokens(shot.styleSamples), null, 2),
              "",
            );
          }
          if (f.screenshot) {
            image = { base64: Buffer.from(shot.bytes).toString("base64"), mediaType: "image/png" };
            sections.push(
              "## Screenshot",
              "Rendered viewport (1280×800) attached to the next turn.",
              "",
            );
          }
        } catch (e) {
          sections.push(
            "## Rendered facets FAILED",
            `screenshot/token render failed for ${toolInput.url}: ${e instanceof Error ? e.message : String(e)}`,
            "",
          );
        } finally {
          await screenshotter.dispose().catch(() => undefined);
        }
      }
    }

    // Cache the fetched page under a handle so follow-ups reuse it without
    // re-fetching: read_page_more (paginate the Markdown) and, later,
    // query_page_html (run selectors). Only when we actually have HTML.
    if (needHtml && html.length > 0) {
      const pageRef = putPageInspection(toolCtx.chatSessionId ?? "no-session", {
        url: finalUrl,
        html,
        markdown: fullMarkdown ?? htmlToMarkdown(html),
        // Present only when this inspect rendered the page — query_page_html
        // then queries the JS-applied DOM, not the static fetch.
        ...(renderedHtml !== undefined ? { renderedHtml } : {}),
      });
      // Emit the handle high in the output so the model reaches for it.
      sections.splice(
        2,
        0,
        `Page handle: ${pageRef} — reuse with read_page_more({ pageRef, cursor }) / query_page_html({ pageRef, ... }); no re-fetch.`,
      );
    }

    sections.push(
      `(${budget.remaining} external fetches left in this session's 10-minute budget.)`,
    );
    return {
      ok: true,
      content: sections.filter((s) => s !== "").join("\n"),
      ...(image ? { image } : {}),
    };
  },
};

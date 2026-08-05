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
 *   - images     — the TOP ~20 asset URLs (images, CSS backgrounds,
 *                  video/audio/source), deduped + ranked by prominence,
 *                  discovered with the same comprehensive `discoverAssetRefs`
 *                  the media importer uses. Feed the URLs to
 *                  import_media_from_urls; for the FULL searchable list of a
 *                  crawled run use `list_page_assets`.
 *   - screenshot — rendered viewport image (attached to the next turn).
 *   - tokens     — design fact base: static CSS-derived inventory + the
 *                  WS1 computed-style sampler (when Playwright is present).
 */

import { formatGenesisInventory, inventoryGenesisDraft } from "@caelo-cms/shared";
import {
  deriveDesignTokens,
  type ElementStyleSample,
  extractAltTexts,
  extractOutboundLinks,
  extractPageMeta,
  fetchRenderedHtml,
  htmlToMarkdown,
  isExternalUrlBlockedError,
  type OutboundLink,
  safeExternalFetch,
  stripConsentSubtrees,
  stripRepeatedSubtrees,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { discoverAssetRefs } from "../../media/import-asset-urls.js";
import {
  describeFetchBudgetDenied,
  externalFetchAllowedHosts,
  takeExternalFetchBudget,
} from "./_external-fetch-budget.js";
import { getExternalScreenshotter } from "./_external-screenshotter.js";
import { putPageInspection, sliceMarkdown } from "./_page-inspection-cache.js";
import type { ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";
import { pngDimensions } from "./screenshot-external-page.js";

const facets = z
  .object({
    links: z.boolean().optional(),
    markdown: z.boolean().optional(),
    screenshot: z.boolean().optional(),
    altTexts: z.boolean().optional(),
    images: z.boolean().optional(),
    meta: z.boolean().optional(),
    tokens: z.boolean().optional(),
  })
  .strict();

const input = z
  .object({
    url: z.string().url(),
    facets: facets.optional(),
    // issue #415 — deliberately TOP-LEVEL, not a facet: `resolveFacets` ORs
    // every facet key into its "any facet named?" check, so a facets-nested
    // flag would count as a requested facet and silently disable the
    // meta+markdown gist default.
    stripBoilerplate: z.boolean().optional(),
  })
  .strict();
type Input = z.infer<typeof input>;

interface ResolvedFacets {
  links: boolean;
  markdown: boolean;
  screenshot: boolean;
  altTexts: boolean;
  images: boolean;
  meta: boolean;
  tokens: boolean;
}

/**
 * Minimal gist when the caller names no facets: `meta` + `markdown`.
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
    (raw.links ||
      raw.markdown ||
      raw.screenshot ||
      raw.altTexts ||
      raw.images ||
      raw.meta ||
      raw.tokens);
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
      images: false,
      tokens: false,
    };
  return {
    links: raw?.links ?? false,
    markdown: raw?.markdown ?? false,
    screenshot: raw?.screenshot ?? false,
    altTexts: raw?.altTexts ?? false,
    images: raw?.images ?? false,
    meta: raw?.meta ?? false,
    tokens: raw?.tokens ?? false,
  };
}

const MAX_STYLESHEETS = 3;
const STYLESHEET_BYTE_CAP = 512 * 1024;
const LINKS_PER_LOCATION = 60;
const IMAGE_INVENTORY_TOP_N = 20;

/** One ranked asset in the inventory: absolute URL + how often it appears
 *  (prominence signal) + the first source `alt` seen for it. */
export interface RankedAsset {
  readonly url: string;
  readonly count: number;
  readonly alt?: string;
}

/**
 * Dedupe + rank the assets `discoverAssetRefs` found across a page's HTML.
 * Ranking = frequency of appearance (a logo/hero repeated in header, nav,
 * and footer floats to the top), tie-broken by first DOM position. Uses
 * the SAME comprehensive discovery the media importer uses — `<img>`
 * src+srcset, CSS `url(...)` (inline style + `<style>` blocks), and
 * `<video>/<audio>/<source>` src+poster+srcset — so no asset type is
 * missed.
 */
export function rankPageAssets(html: string, baseUrl: string): RankedAsset[] {
  const refs = discoverAssetRefs(html, "html", baseUrl).refs;
  const byUrl = new Map<string, { url: string; count: number; alt?: string; firstPos: number }>();
  for (const ref of refs) {
    const existing = byUrl.get(ref.url);
    if (existing) {
      existing.count += 1;
      if (existing.alt === undefined && ref.alt) existing.alt = ref.alt;
    } else {
      byUrl.set(ref.url, {
        url: ref.url,
        count: 1,
        ...(ref.alt ? { alt: ref.alt } : {}),
        firstPos: ref.start,
      });
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => b.count - a.count || a.firstPos - b.firstPos)
    .map(({ url, count, alt }) => (alt !== undefined ? { url, count, alt } : { url, count }));
}

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
    "`altTexts` (accessibility inventory of img alt + aria-label; when `images` is ALSO on, this narrows to aria-labels since that inventory already carries each img's alt — no double-listing), " +
    "`images` (the TOP ~20 asset URLs — images, CSS backgrounds, video/audio/source — deduped + ranked by prominence, each with its `alt=`; feed the URLs to import_media_from_urls to pull them into the media library; for the COMPLETE searchable list of a crawled site use list_page_assets), " +
    "`screenshot` (rendered FULL-PAGE image on your next turn — the whole page, not just the top fold), " +
    "`tokens` (design token inventory: the RENDERED computed-style tokens when Chromium is available, else a static CSS-derived fallback — ONE section, not both), " +
    "The READING facets (markdown + meta's headings outline) are CLEANED by default (top-level `stripBoilerplate`, default true): cookie-consent banners, hidden DOM subtrees (mobile-nav clones, offscreen carousel slides — rendered path only) and same-page repeated blocks are stripped BEFORE conversion, and the result reports exact counts of what was removed. Pass `stripBoilerplate: false` (top-level, NOT inside facets) to read the page verbatim; `query_page_html` and the inventory facets (links, altTexts, images, tokens) always see the FULL unstripped DOM either way. " +
    "There is NO raw-HTML/markup facet: for specific structure use `query_page_html` (by selector or a natural-language `describe`), which is bounded — never dump a whole page's HTML into the chat. " +
    "Step 1 understand a page → default (`{}` = meta + markdown) + `{links:true}` on the FIRST/homepage inspect for site structure. Step 3 build a template from a sample → `{screenshot:true, tokens:true, altTexts:true, images:true}` for the visual + design + accessibility + asset URLs, markdown for the content, and `query_page_html` for any specific section. " +
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
      stripBoilerplate: {
        type: "boolean",
        description:
          "Default true: consent/cookie banners, hidden DOM subtrees (rendered path) and same-page repeated blocks (carousel clones, duplicate navs) are stripped from the READING facets (markdown + meta's headings outline) before conversion, with exact counts reported in the result. TOP-LEVEL flag, deliberately not a facet. Set false to read the page verbatim (e.g. when the cleanup removed something you needed). query_page_html and the inventory facets (links, altTexts, images, tokens) always see the full unstripped DOM either way.",
      },
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
          altTexts: {
            type: "boolean",
            description:
              "Accessibility inventory of img alt + aria-label. When `images` is also requested it narrows to aria-labels (that inventory already lists each img's alt), so the two never double-list.",
          },
          images: {
            type: "boolean",
            description:
              "The TOP ~20 asset URLs (images, CSS background-images, video/audio/source src+poster+srcset), deduped and ranked by prominence (frequency of appearance). Says '(showing top 20 of N)' when truncated. Feed the URLs to import_media_from_urls; for the complete searchable list of a crawled run use list_page_assets({ runId, search }).",
          },
          screenshot: {
            type: "boolean",
            description:
              "Rendered FULL-PAGE image (the whole page, not just the top fold), attached to your next turn (needs Playwright).",
          },
          tokens: {
            type: "boolean",
            description:
              "Design token inventory: the RENDERED computed-style tokens (WS1 sampler) when Chromium is available, else a static CSS-derived fallback — ONE section, not both.",
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
        content: `${describeFetchBudgetDenied(budget)} This tool is for a one-page glance — if you need many pages, propose the crawl via \`propose_site_import\` instead.`,
      };
    }
    const f = resolveFacets(toolInput.facets);
    const strip = toolInput.stripBoilerplate ?? true;
    const allowedHosts = externalFetchAllowedHosts();
    const needHtml = f.links || f.markdown || f.altTexts || f.images || f.meta || f.tokens;
    const needRender = needHtml || f.screenshot;

    // ── Render-first (docs: rendered-first plan) ───────────────────────────
    // Every content facet reads the JS-APPLIED DOM, not the pre-JS source: a
    // page that sets an image/video `src`, builds its nav, or injects sections
    // with JavaScript is invisible to a static fetch. When a screenshot is
    // requested we render via `capture` (pixels + html + styles in one
    // session); otherwise via `fetchRenderedHtml` (html + optional styles, no
    // pixel cost). Both fall back to a static fetch — with a loud note — when
    // Chromium is unavailable or the render fails.
    let html = "";
    let finalUrl = toolInput.url;
    let renderNote: string | undefined;
    let styleSamples: readonly ElementStyleSample[] | undefined;
    let screenshotBytes: Uint8Array | undefined;
    let screenshotHeight = 800;
    // issue #415 — the render's hidden-element pass: the DOM minus invisible
    // subtrees, and how many it removed. Rendered path only (visibility is
    // layout knowledge); stays undefined on the static fallback, which the
    // counters line reports loudly.
    let visibleHtml: string | undefined;
    let hiddenRemoved: number | undefined;

    const screenshotter = needRender ? await getExternalScreenshotter({ allowedHosts }) : null;

    if (f.screenshot && screenshotter) {
      try {
        const shot = await screenshotter.capture(toolInput.url, {
          width: 1280,
          height: 800,
          external: true,
          fullPage: true,
          sampleStyles: f.tokens,
          captureHtml: true,
          stripHidden: strip && needHtml,
        });
        html = shot.renderedHtml ?? "";
        finalUrl = shot.finalUrl ?? toolInput.url;
        styleSamples = shot.styleSamples;
        screenshotBytes = shot.bytes;
        screenshotHeight = shot.height;
        visibleHtml = shot.visibleHtml;
        hiddenRemoved = shot.hiddenRemoved;
      } catch (e) {
        if (isExternalUrlBlockedError(e)) return { ok: false, content: e.message };
        // Non-blocked capture failure: fall through to fetchRenderedHtml for
        // the HTML; the screenshot facet reports UNAVAILABLE below.
      }
    }

    if (needRender && html === "") {
      const rf = await fetchRenderedHtml(toolInput.url, {
        screenshotter,
        allowedHosts,
        maxBytes: 2 * 1024 * 1024,
        sampleStyles: f.tokens,
        stripHidden: strip && needHtml,
      });
      if (!rf.ok) {
        if (rf.blocked) return { ok: false, content: rf.message };
        return {
          ok: false,
          content: `inspect_external_page: ${toolInput.url} — ${rf.message}. Verify the address with the operator.`,
        };
      }
      html = rf.html;
      finalUrl = rf.finalUrl;
      renderNote = rf.note;
      styleSamples = styleSamples ?? rf.styleSamples;
      visibleHtml = rf.visibleHtml;
      hiddenRemoved = rf.hiddenRemoved;
    }

    // ── Cleanup stage (issue #415) — between fetch and htmlToMarkdown ──────
    // Consent chrome, hidden DOM (mobile-nav clones, offscreen carousel
    // slides — removed during the render, where visibility is known) and
    // same-page repeated subtrees are noise for READING a page: on real
    // homepages they made ~40% of the Markdown redundant and pushed content
    // behind extra read_page_more turns. The cleaned HTML feeds ONLY the two
    // READING facets — the Markdown (+ its pageRef cache) and the meta
    // headings outline (a consent modal's <h2> is not page structure). The
    // INVENTORY facets (links/altTexts/images/tokens) and the cached HTML
    // for query_page_html stay comprehensive on the unstripped DOM. Never
    // silent (CLAUDE.md §2): the counters line always states what was
    // removed — or that cleanup was off, or that the hidden pass could not
    // run (static fallback).
    let markdownHtml = html;
    let cleanupLine: string | null = null;
    if (needHtml && html.length > 0) {
      if (strip) {
        const consent = stripConsentSubtrees(visibleHtml ?? html);
        const repeats = stripRepeatedSubtrees(consent.html);
        markdownHtml = repeats.html;
        const hiddenPart =
          hiddenRemoved !== undefined
            ? `${hiddenRemoved} hidden subtree(s)`
            : "hidden-element pass skipped (page not rendered)";
        cleanupLine = `Boilerplate stripped: ${consent.removed} consent block(s), ${hiddenPart}, ${repeats.removed} repeated block(s) — the Markdown + meta outline below (and read_page_more) are cleaned; query_page_html and the inventory facets see the full DOM. Re-run with stripBoilerplate:false for the verbatim text.`;
      } else {
        cleanupLine =
          "Boilerplate cleanup OFF (stripBoilerplate:false) — consent banners, hidden subtrees and repeated blocks appear verbatim.";
      }
    }

    const enabled = Object.entries(f)
      .filter(([, on]) => on)
      .map(([name]) => name);
    const sections: string[] = [
      `# External page inspection — ${finalUrl}`,
      `Facets: ${enabled.join(", ")}`,
      ...(cleanupLine !== null ? [cleanupLine] : []),
      "",
    ];

    if (f.meta) {
      // Cleaned DOM (issue #415): the h1–h3 outline is a reading surface —
      // consent/hidden/duplicate headings would re-import the stripped noise.
      // Head-derived fields (title, canonical, hreflang) are untouched by the
      // strippers, so they are identical either way.
      const meta = extractPageMeta(markdownHtml, finalUrl);
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
      fullMarkdown = htmlToMarkdown(markdownHtml);
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
      // When the image/asset inventory is ALSO requested it already lists
      // every img with its `alt=`, so drop the img-alt rows here (they'd
      // double up) and keep only what that inventory can't carry: aria-labels
      // and any img-alt with no resolvable src.
      const relevant = f.images ? alts.filter((a) => a.kind !== "img-alt" || !a.src) : alts;
      const lines = relevant.map((a) =>
        a.kind === "img-alt"
          ? `- img alt="${a.text}"${a.src ? ` (${a.src})` : ""}`
          : `- aria-label="${a.text}"`,
      );
      const emptyNote = f.images
        ? "(no aria-labels; img alts are listed in the image/asset inventory)"
        : "(no img alt / aria-label attributes found)";
      sections.push(
        f.images
          ? "## Alt-text inventory (aria-labels; img alts are in the image/asset inventory)"
          : "## Alt-text inventory",
        lines.length > 0 ? lines.join("\n") : emptyNote,
        "",
      );
    }

    // Image / asset inventory: the TOP ~20 asset URLs (images, CSS
    // backgrounds, video/audio/source) ranked by prominence, discovered
    // with the same comprehensive `discoverAssetRefs` the media importer
    // uses. This is the raw material for import_media_from_urls — the AI
    // names the exact URLs it wants and they land in the media library.
    if (f.images) {
      const ranked = rankPageAssets(html, finalUrl);
      const shown = ranked.slice(0, IMAGE_INVENTORY_TOP_N);
      const assetLines = shown.map(
        (a) =>
          `- ${a.url}${a.count > 1 ? ` (×${a.count})` : ""}${a.alt ? ` (alt="${a.alt}")` : ""}`,
      );
      const truncated = ranked.length > IMAGE_INVENTORY_TOP_N;
      sections.push(
        "## Image / asset inventory (source URLs)",
        assetLines.length > 0 ? assetLines.join("\n") : "(no asset references found)",
        truncated ? `(showing top ${IMAGE_INVENTORY_TOP_N} of ${ranked.length})` : "",
        assetLines.length > 0
          ? "Import the ones you need with import_media_from_urls({ urls: [...] })."
          : "",
        truncated
          ? "For the COMPLETE, searchable asset list of a crawled site, use list_page_assets({ runId, search? }) (available once you've run propose_site_import)."
          : "",
        "",
      );
    }

    // Emit the rendered facets from the ONE up-front render (see the
    // render-first block near the handler top). No second capture here.
    let image: ToolResult["image"];
    // The rendered DOM to cache on the pageRef so query_page_html runs its
    // selectors against the JS-applied DOM, not a static fetch. Only set when
    // we actually rendered (renderNote is present exactly on the static fallback).
    const renderedHtml: string | undefined = renderNote === undefined ? html : undefined;

    // Loud note when we could NOT render (static fallback) — a JS-driven page
    // may be incomplete. Surfaced high so the model doesn't trust a partial read.
    if (renderNote) {
      sections.splice(3, 0, "## Note — page not rendered", renderNote, "");
    }

    // Whether the RENDERED computed-style tokens were emitted. The static
    // CSS-derived fact base is their FALLBACK (emitted below only when the
    // render didn't produce them), so a `tokens` request yields ONE
    // design-token section instead of doubling static + rendered.
    let renderedTokensEmitted = false;
    if (f.tokens && styleSamples && styleSamples.length > 0) {
      sections.push(
        "## Computed-style design tokens (rendered)",
        JSON.stringify(deriveDesignTokens(styleSamples), null, 2),
        "",
      );
      renderedTokensEmitted = true;
    }
    if (f.screenshot) {
      if (screenshotBytes) {
        image = { base64: Buffer.from(screenshotBytes).toString("base64"), mediaType: "image/png" };
        // Report the TRUE captured dimensions (read from the PNG), not the
        // viewport height — a full-page shot is much taller than 800px.
        const dims = pngDimensions(screenshotBytes);
        const shotW = dims?.width ?? 1280;
        const shotH = dims?.height ?? screenshotHeight;
        sections.push(
          "## Screenshot",
          `Rendered full page (${shotW}px wide, ${shotH}px tall) attached to the next turn.`,
          "",
        );
      } else {
        sections.push(
          "## Screenshot UNAVAILABLE",
          "Could not render the page in headless Chromium (Playwright not installed, or the render failed — `bun node_modules/playwright/cli.js install chromium` fixes it on self-hosted installs). Do NOT claim you saw the page. The non-rendered facets above are still valid.",
          "",
        );
      }
    }

    // Static CSS-derived fact base — FALLBACK for the rendered computed-style
    // tokens. Emitted only when the render didn't produce them (no Playwright,
    // render failed, or no style samples), so a `tokens` request yields ONE
    // design-token section instead of doubling static + rendered.
    if (f.tokens && !renderedTokensEmitted) {
      sections.push(
        "## Design fact base (static, CSS-derived)",
        await staticDesignFactBase(html, finalUrl, allowedHosts),
        "",
      );
    }

    // Cache the fetched page under a handle so follow-ups reuse it without
    // re-fetching: read_page_more (paginate the Markdown) and, later,
    // query_page_html (run selectors). Only when we actually have HTML.
    if (needHtml && html.length > 0) {
      const pageRef = putPageInspection(toolCtx.chatSessionId ?? "no-session", {
        url: finalUrl,
        html,
        // The STRIPPED Markdown (issue #415) — read_page_more paginates the
        // cleaned text; the html/renderedHtml stay unstripped so
        // query_page_html queries the full DOM.
        markdown: fullMarkdown ?? htmlToMarkdown(markdownHtml),
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

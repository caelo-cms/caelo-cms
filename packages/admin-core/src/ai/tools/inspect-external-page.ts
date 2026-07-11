// SPDX-License-Identifier: MPL-2.0

/**
 * issue #189 — `inspect_external_page`: fetch ONE external page
 * (SSRF-guarded, #191) and return the design fact base + a content
 * outline. This is the "glance" that makes the first migration turn
 * intelligent — the AI sees what the operator's site IS before asking
 * keep-design vs redesign, without the Owner-gated crawl.
 *
 * Same-host stylesheets (up to 3, size-capped) are inlined before the
 * genesis-inventory pass — external sites keep their CSS in files, and
 * a style-blind inventory would report an empty palette.
 */

import { formatGenesisInventory, inventoryGenesisDraft } from "@caelo-cms/shared";
import { isExternalUrlBlockedError, safeExternalFetch } from "@caelo-cms/site-importer";
import { z } from "zod";
import { externalFetchAllowedHosts, takeExternalFetchBudget } from "./_external-fetch-budget.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z.object({ url: z.string().url() }).strict();
type Input = z.infer<typeof input>;

const MAX_STYLESHEETS = 3;
const STYLESHEET_BYTE_CAP = 512 * 1024;

/** Linear scan for `<link ... rel=stylesheet ... href=...>` URLs. */
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
      // Same-host only: cross-origin CSS (CDNs, font providers) is
      // skipped rather than fetched — the guard would allow public
      // hosts, but the glance shouldn't fan out across origins.
      if (abs.host === new URL(baseUrl).host) out.push(abs.toString());
    } catch {
      // unparseable href — skip
    }
  }
  return out.slice(0, MAX_STYLESHEETS);
}

/** Linear heading + title extraction (bounded, no nested quantifiers). */
export function extractContentOutline(html: string): {
  title: string;
  metaDescription: string;
  headings: string[];
  sameHostPaths: (baseUrl: string) => string[];
} {
  const title = /<title[^>]*>([^<]{0,300})/i.exec(html)?.[1]?.trim() ?? "";
  const metaDescription =
    /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']{0,500})["']/i.exec(
      html,
    )?.[1] ?? "";
  const headings: string[] = [];
  const headingRe = /<h([1-3])\b[^>]*>([^<]{0,200})/gi;
  let m = headingRe.exec(html);
  while (m !== null && headings.length < 30) {
    const text = m[2]?.trim();
    if (text) headings.push(`h${m[1]}: ${text}`);
    m = headingRe.exec(html);
  }
  const sameHostPaths = (baseUrl: string): string[] => {
    const host = new URL(baseUrl).host;
    const paths = new Set<string>();
    const linkRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
    let lm = linkRe.exec(html);
    while (lm !== null && paths.size < 500) {
      const href = lm[1];
      if (
        href &&
        !href.startsWith("#") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("tel:")
      ) {
        try {
          const u = new URL(href, baseUrl);
          if (u.host === host) paths.add(u.pathname);
        } catch {
          // skip
        }
      }
      lm = linkRe.exec(html);
    }
    return [...paths];
  };
  return { title, metaDescription, headings, sameHostPaths };
}

export const inspectExternalPageTool: ToolDefinitionWithHandler<Input> = {
  name: "inspect_external_page",
  description:
    "Fetch ONE page of an EXTERNAL website (the operator's existing site, a reference site) and return its design fact base (colors with usage counts, gradients, fonts, spacing, structural outline — same inventory Genesis uses) plus a content outline (title, meta description, headings, same-host link count, sitemap presence). " +
    "Use this FIRST when an operator names an existing site — look before you ask keep-design vs redesign, and before proposing a crawl. " +
    "Do NOT use for whole-site work: this is one page, no link-following — for the full site use `propose_site_import` (Owner-gated crawl). Do NOT use on Caelo's own pages — use `inspect_page_render`. " +
    "Only public http(s) URLs work; private/internal addresses are refused by the SSRF guard.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "Absolute public URL, e.g. https://example.com/" },
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
    const allowedHosts = externalFetchAllowedHosts();
    let res: Awaited<ReturnType<typeof safeExternalFetch>>;
    try {
      res = await safeExternalFetch(toolInput.url, { allowedHosts, maxBytes: 2 * 1024 * 1024 });
    } catch (e) {
      if (isExternalUrlBlockedError(e)) {
        return { ok: false, content: e.message };
      }
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

    // Inline same-host stylesheets so the inventory sees the real
    // palette. Failures are per-sheet non-fatal — noted in the output
    // so a thin palette is explainable rather than mysterious.
    const sheetUrls = extractStylesheetHrefs(res.bodyText, res.finalUrl);
    const sheetNotes: string[] = [];
    let inlinedCss = "";
    for (const sheetUrl of sheetUrls) {
      try {
        const css = await safeExternalFetch(sheetUrl, {
          allowedHosts,
          maxBytes: STYLESHEET_BYTE_CAP,
        });
        if (css.ok) inlinedCss += `\n<style>${css.bodyText}</style>`;
        else sheetNotes.push(`stylesheet ${sheetUrl} answered HTTP ${css.status}`);
      } catch (e) {
        sheetNotes.push(
          `stylesheet ${sheetUrl} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const inventory = inventoryGenesisDraft(res.bodyText + inlinedCss);
    const outline = extractContentOutline(res.bodyText);
    const paths = outline.sameHostPaths(res.finalUrl);

    // Sitemap probe — a strong signal for the later crawl-scope
    // estimate and a cheap way to say "this site has ~N pages".
    let sitemapNote = "no sitemap.xml found";
    try {
      const origin = new URL(res.finalUrl).origin;
      const sm = await safeExternalFetch(`${origin}/sitemap.xml`, {
        allowedHosts,
        maxBytes: 256 * 1024,
      });
      if (sm.ok && (sm.bodyText.includes("<urlset") || sm.bodyText.includes("<sitemapindex"))) {
        let locCount = 0;
        let idx = sm.bodyText.indexOf("<loc>");
        while (idx !== -1) {
          locCount += 1;
          idx = sm.bodyText.indexOf("<loc>", idx + 5);
        }
        sitemapNote = sm.bodyText.includes("<sitemapindex")
          ? `sitemap INDEX with ${locCount} child sitemaps (site is likely large)`
          : `sitemap.xml lists ${locCount} URLs${sm.bodyText.length >= 250 * 1024 ? " (truncated read — actual count may be higher)" : ""}`;
      }
    } catch {
      // Sitemap probe is best-effort context, not a failure of the
      // inspection itself.
    }

    const sections = [
      `# External page inspection — ${res.finalUrl}`,
      "",
      `Title: ${outline.title || "(none)"}`,
      outline.metaDescription ? `Meta description: ${outline.metaDescription}` : "",
      "",
      "## Content outline",
      outline.headings.length > 0 ? outline.headings.join("\n") : "(no h1–h3 headings found)",
      "",
      `Same-host link paths (${paths.length}${paths.length >= 500 ? "+" : ""}): ${paths.slice(0, 25).join(", ")}${paths.length > 25 ? ", …" : ""}`,
      `Sitemap: ${sitemapNote}`,
      "",
      "## Design fact base (genesis-inventory)",
      formatGenesisInventory(inventory),
      sheetNotes.length > 0 ? `\nStylesheet notes: ${sheetNotes.join("; ")}` : "",
      "",
      `(${budget.remaining} external fetches left in this session's 10-minute budget.)`,
    ].filter((s) => s !== "");

    return { ok: true, content: sections.join("\n") };
  },
};

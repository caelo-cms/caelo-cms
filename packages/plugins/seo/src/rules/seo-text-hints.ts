// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — write hints after the AI set a page's SEO texts (`page_seo`
 * writes: set_page_seo_many, autofill_page_seo_many, bulk_optimize_seo).
 * Rules of thumb, never findings:
 *
 * - the `<title>` and meta description as a result list cuts them (pixel
 *   width, ./serp-width.ts), read as the page renders them: its own text,
 *   else its page type's or the site's title template;
 * - a page whose content has not changed for a long time ({@link STALE_DAYS})
 *   — a new description does not make old content current;
 * - another page with a similar title: two pages on one topic compete for
 *   the same searches.
 *
 * Reads run in the writing chat's scope (a render invocation on its
 * branch), so the hint describes what the chat wrote.
 */

import type { PluginContextTier1, PluginWrite } from "@caelo-cms/plugin-sdk";
import type { SeoWriteHintRule } from "../hints/index.js";
import { DESCRIPTION_FONT_PX, SERP_LIMITS, TITLE_FONT_PX, textWidthPx } from "./serp-width.js";

/** A page unchanged for longer than this many days gets the refresh hint. */
export const STALE_DAYS = 365;

/** Word overlap from which two titles count as similar (Jaccard of their words). */
export const SIMILAR_TITLE = 0.6;

/** Pages one write's similar-title search looks at. */
const SIMILAR_CANDIDATES = 20;

interface ResolvedHead {
  readonly title: { readonly value: string };
  readonly metaDescription: { readonly value: string };
}

/** The page's head as a build renders it, in the chat's view; null when the page is gone. */
async function resolvedHead(ctx: PluginContextTier1, pageId: string): Promise<ResolvedHead | null> {
  if (!ctx.cms) throw new Error("seo: the cms_admin grant is missing, so page SEO cannot be read");
  const r = (await ctx.cms.call("pages_seo.get", { pageId })) as { resolved: ResolvedHead | null };
  return r.resolved;
}

/** The words of a title, for comparing titles (case and punctuation aside). */
export function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1),
  );
}

/** How alike two titles are: shared words over all words (0–1). */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** The width hints of one page's resolved title and description. */
export function widthHints(path: string, head: ResolvedHead): string[] {
  const out: string[] = [];
  const title = head.title.value;
  const titlePx = textWidthPx(title, TITLE_FONT_PX);
  if (title && titlePx > SERP_LIMITS.desktop.title) {
    out.push(
      `The <title> of ${path} is about ${titlePx} px wide; a desktop result shows about ${SERP_LIMITS.desktop.title} px, so it ends in "…" there. Put the words that matter first.`,
    );
  }
  const description = head.metaDescription.value;
  const descriptionPx = textWidthPx(description, DESCRIPTION_FONT_PX);
  if (description && descriptionPx > SERP_LIMITS.desktop.description) {
    out.push(
      `The meta description of ${path} is about ${descriptionPx} px wide; a result shows about ${SERP_LIMITS.desktop.description} px (desktop) or ${SERP_LIMITS.mobile.description} px (phone). Search engines often pick their own text anyway.`,
    );
  } else if (description && descriptionPx < SERP_LIMITS.mobile.description / 2) {
    out.push(
      `The meta description of ${path} is short (about ${descriptionPx} px): a result has room for about twice as much on a phone; say what the page offers.`,
    );
  }
  return out;
}

/** One page as `pages.list` / `pages.search` answer it (the fields read here). */
interface PageRow {
  readonly id: string;
  readonly title: string;
  readonly currentPath: string;
  readonly updatedAt: string;
  readonly status: string;
}

/** The SEO text hint family. */
export const SEO_TEXT_HINT_RULE: SeoWriteHintRule = {
  name: "seo-texts",
  async hints(ctx, writes: readonly PluginWrite[]) {
    const pageIds = [...new Set(writes.flatMap((w) => (w.kind === "page_seo" ? [w.pageId] : [])))];
    if (pageIds.length === 0) return [];
    if (!ctx.cms) throw new Error("seo: the cms_admin grant is missing, so pages cannot be read");
    const listed = (await ctx.cms.call("pages.list", { pageIds: pageIds.slice(0, 1000) })) as {
      pages: PageRow[];
    };
    const out: string[] = [];
    const now = Date.now();
    // A handful of pages per write: past that the hints would bury the result.
    for (const page of listed.pages.slice(0, 5)) {
      const head = await resolvedHead(ctx, page.id);
      if (!head) continue;
      out.push(...widthHints(page.currentPath, head));
      const days = Math.floor((now - Date.parse(page.updatedAt)) / 86_400_000);
      if (page.status === "published" && days > STALE_DAYS) {
        out.push(
          `${page.currentPath} has not changed for ${days} days: new SEO texts do not make old content current; offer the operator to refresh the page itself.`,
        );
      }
      // The two longest words: every word of a query must match, and a
      // similar title shares most words, the telling ones above all.
      const query = [...titleWords(page.title)]
        .sort((a, b) => b.length - a.length)
        .slice(0, 2)
        .join(" ");
      if (query === "") continue;
      const found = (await ctx.cms.call("pages.search", {
        query,
        limit: SIMILAR_CANDIDATES,
      })) as { pages: PageRow[] };
      const similar = found.pages.find(
        (p) => p.id !== page.id && titleSimilarity(p.title, page.title) >= SIMILAR_TITLE,
      );
      if (similar) {
        out.push(
          `${similar.currentPath} ("${similar.title}") has a title much like ${page.currentPath}: two pages on one topic compete for the same searches. Make each title say what sets the page apart, or offer the operator to merge them.`,
        );
      }
    }
    return out;
  },
};

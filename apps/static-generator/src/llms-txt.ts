// SPDX-License-Identifier: MPL-2.0

/**
 * #1763 — `/llms.txt` (llmstxt.org): the site's indexable pages for AI
 * agents, by page type, each a Markdown link with its meta description.
 * Off unless a plugin switches it on (the seo plugin's setting, through
 * `agentFilesOperation`); core builds every byte of it.
 *
 * What it lists is the build's indexing state, the one decision the
 * sitemap and the feed read too: published pages that are indexable (not
 * noindex, not the 404 page, not left out by a plugin) and canonical to
 * themselves, page 1 of a paginated overview only. Only what the site's
 * authors wrote reaches it — titles, meta descriptions, page type names,
 * the site's name — never a page's body or anything visitors wrote, so the
 * file cannot carry text a visitor slipped in for an agent to follow.
 *
 * It is a build file like the sitemap: on staging with the Stage, live
 * with Publish live, kept by a plugin-data build, restored by a rollback.
 * Honest about what it is worth: Google reads none of it and says AI
 * search needs no special file (Search Central, May 2026); a log study of
 * 2026 found most llms.txt files never requested. Coding agents read such
 * files, which is all it is for.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { SeoPass } from "./seo-pass.js";

/** Where the file is served. */
export const LLMS_TXT_FILE = "llms.txt";

/** Its Content-Type: Markdown text, shown by browsers as text. */
export const LLMS_TXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * The most bytes the file takes. Agents load it whole into a context; past
 * this the rest of the pages are left out and the file points at the
 * sitemap, which lists them all.
 */
export const LLMS_TXT_MAX_BYTES = 256 * 1024;

/** One page the file may list: the build's indexing state for it. */
export interface LlmsTxtPage {
  readonly pageId: string;
  /** Its absolute public URL (the canonical it carries). */
  readonly url: string;
  readonly title: string;
  readonly metaDescription: string;
  /** Its page type's name, the section it is listed under. */
  readonly pageType: string;
}

/** Text on one line: no line break can start a heading or a list item of its own. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Link text in Markdown: brackets and backslashes escaped. */
function linkText(text: string): string {
  return oneLine(text).replace(/([\\[\]])/g, "\\$1");
}

/** A URL inside `(…)`: parentheses and spaces encoded. */
function linkUrl(url: string): string {
  return url.replace(/[()\s]/g, (c) =>
    c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c),
  );
}

/**
 * The file. Sections follow the page types in name order, pages keep the
 * order given (the build's). Returns no trailing blank line beyond one
 * newline.
 */
export function renderLlmsTxt(args: {
  readonly siteName: string;
  /** The home page's meta description, the file's summary; "" for none. */
  readonly summary: string;
  readonly pages: readonly LlmsTxtPage[];
  /** The sitemap's URL when the build writes one: the pointer past the cap. */
  readonly sitemapUrl: string | null;
  readonly maxBytes?: number;
}): string {
  const max = args.maxBytes ?? LLMS_TXT_MAX_BYTES;
  const encoder = new TextEncoder();
  const head = [
    `# ${oneLine(args.siteName)}`,
    ...(args.summary ? ["", `> ${oneLine(args.summary)}`] : []),
  ];
  const byType = new Map<string, LlmsTxtPage[]>();
  for (const p of args.pages) byType.set(p.pageType, [...(byType.get(p.pageType) ?? []), p]);
  const types = [...byType.keys()].sort((a, b) => a.localeCompare(b));
  const lines = [...head];
  let bytes = encoder.encode(`${lines.join("\n")}\n`).length;
  // Room for the closing pointer, so it always fits.
  const tail = args.sitemapUrl
    ? ["", "## More", "", `- [Every page of the site](${linkUrl(args.sitemapUrl)}): the sitemap`]
    : [];
  const tailBytes = encoder.encode(`${tail.join("\n")}\n`).length;
  let left = 0;
  for (const type of types) {
    const entries = byType.get(type) ?? [];
    const section = ["", `## ${oneLine(type)}`, ""];
    const sectionBytes = encoder.encode(`${section.join("\n")}\n`).length;
    let opened = false;
    for (const p of entries) {
      const description = oneLine(p.metaDescription);
      const line = `- [${linkText(p.title)}](${linkUrl(p.url)})${description ? `: ${description}` : ""}`;
      const lineBytes = encoder.encode(`${line}\n`).length + (opened ? 0 : sectionBytes);
      if (left > 0 || bytes + lineBytes + tailBytes > max) {
        left += 1;
        continue;
      }
      if (!opened) {
        lines.push(...section);
        opened = true;
      }
      lines.push(line);
      bytes += lineBytes;
    }
  }
  if (left > 0) lines.push(...tail);
  return `${lines.join("\n")}\n`;
}

/**
 * The file of a build: its indexing state ({@link SeoPass.indexedPages}),
 * the page types' names, the site's name (else its host) and the home
 * page's meta description as the summary.
 */
export async function buildLlmsTxt(
  tx: TransactionRunner,
  seo: Pick<SeoPass, "indexedPages">,
  site: { readonly siteBaseUrl: string; readonly sitemap: boolean },
): Promise<string> {
  const indexed = await seo.indexedPages();
  const { pageTypes, siteName } = await loadLlmsTxtContext(
    tx,
    indexed.map((p) => p.pageId),
  );
  const base = new URL(site.siteBaseUrl);
  const home = indexed.find((p) => new URL(p.url).pathname === "/");
  return renderLlmsTxt({
    siteName: siteName?.trim() || base.host,
    summary: home?.metaDescription ?? "",
    pages: indexed.map((p) => {
      const pageType = pageTypes.get(p.pageId);
      if (pageType === undefined) {
        throw new Error(`llms.txt: page ${p.pageId} of the build has no page type`);
      }
      return { ...p, pageType };
    }),
    sitemapUrl: site.sitemap ? new URL("/sitemap.xml", base).href : null,
  });
}

/** A JSON value bound as one jsonb parameter. */
function jsonb(value: unknown): ReturnType<typeof sql> {
  return sql`(${JSON.stringify(value)}::text)::jsonb`;
}

/**
 * The page type name of each page (a page whose type has no name shows its
 * slug), and the site's name. Read in chunks; the build's transaction.
 */
export async function loadLlmsTxtContext(
  tx: TransactionRunner,
  pageIds: readonly string[],
): Promise<{ readonly pageTypes: Map<string, string>; readonly siteName: string | null }> {
  const pageTypes = new Map<string, string>();
  for (let at = 0; at < pageIds.length; at += 1000) {
    const ids = pageIds.slice(at, at + 1000);
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, coalesce(pt.definition->>'name', pt.slug) AS name
      FROM pages p JOIN page_types pt ON pt.id = p.page_type_id
      WHERE p.id IN (SELECT jsonb_array_elements_text(${jsonb(ids)})::uuid)
    `)) as unknown as { page_id: string; name: string }[];
    for (const r of rows) pageTypes.set(r.page_id, r.name);
  }
  const site = (await tx.execute(sql`
    SELECT site_name FROM site_defaults WHERE id = 1
  `)) as unknown as { site_name: string | null }[];
  return { pageTypes, siteName: site[0]?.site_name ?? null };
}

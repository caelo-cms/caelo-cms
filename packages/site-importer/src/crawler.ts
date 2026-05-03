// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — same-domain BFS crawler. Bounded by depth + maxPages. Polite:
 *   - 100ms delay between requests
 *   - one User-Agent string identifying as Caelo importer
 *   - declines redirects to a different host
 *   - skips non-text/html responses
 *
 * Returns per-URL extracted page records ready for the imports.
 * accept_page op to promote into real `pages` rows.
 */

import { extractModulesFromHtml, extractThemeTokens, extractTitle } from "./extractor.js";

export interface CrawlOptions {
  readonly sourceUrl: string;
  /** BFS depth from the source URL. Default 2. */
  readonly depth?: number;
  /** Hard ceiling on total pages crawled. Default 50. */
  readonly maxPages?: number;
  /** ms between requests. Default 100. */
  readonly throttleMs?: number;
  /** Optional fetch override for tests. */
  readonly fetcher?: (url: string) => Promise<{ ok: boolean; html: string; contentType: string }>;
}

export interface CrawledPage {
  readonly url: string;
  readonly proposedSlug: string;
  readonly title: string;
  readonly modules: ReturnType<typeof extractModulesFromHtml>;
  readonly themeTokens: Record<string, string>;
}

export interface CrawlResult {
  readonly pages: CrawledPage[];
  readonly seenCount: number;
  readonly errors: ReadonlyArray<{ url: string; reason: string }>;
}

const USER_AGENT = "CaleoSiteImporter/1.0 (+https://caleo-cms.com/imports — research-only crawler)";

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const depth = opts.depth ?? 2;
  const maxPages = opts.maxPages ?? 50;
  const throttle = opts.throttleMs ?? 100;
  const fetcher = opts.fetcher ?? defaultFetcher;

  const sourceParsed = new URL(opts.sourceUrl);
  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: opts.sourceUrl, depth: 0 }];
  const pages: CrawledPage[] = [];
  const errors: Array<{ url: string; reason: string }> = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift();
    if (!next) break;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    if (throttle > 0 && pages.length > 0) {
      await new Promise((r) => setTimeout(r, throttle));
    }
    let res: { ok: boolean; html: string; contentType: string };
    try {
      res = await fetcher(next.url);
    } catch (e) {
      errors.push({ url: next.url, reason: (e as Error).message });
      continue;
    }
    if (!res.ok) {
      errors.push({ url: next.url, reason: "non-OK status" });
      continue;
    }
    if (!res.contentType.includes("text/html")) {
      errors.push({ url: next.url, reason: `skipped non-html (${res.contentType})` });
      continue;
    }
    const title = extractTitle(res.html);
    const modules = extractModulesFromHtml(res.html);
    const themeTokens = extractThemeTokens(res.html);
    pages.push({
      url: next.url,
      proposedSlug: urlToSlug(next.url, opts.sourceUrl),
      title,
      modules,
      themeTokens,
    });

    // Enqueue same-domain links if depth allows.
    if (next.depth < depth) {
      for (const href of extractLinks(res.html)) {
        try {
          const abs = new URL(href, next.url).toString();
          const u = new URL(abs);
          if (u.host !== sourceParsed.host) continue;
          // Strip hash + trailing slash for de-dupe.
          const norm = `${u.origin}${u.pathname.replace(/\/$/, "") || "/"}`;
          if (!seen.has(norm)) {
            queue.push({ url: norm, depth: next.depth + 1 });
          }
        } catch {
          // bad URL; skip
        }
      }
    }
  }

  return { pages, seenCount: seen.size, errors };
}

async function defaultFetcher(
  url: string,
): Promise<{ ok: boolean; html: string; contentType: string }> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("text/html")) {
    return { ok: res.ok, html: "", contentType };
  }
  const html = await res.text();
  return { ok: true, html, contentType };
}

function extractLinks(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const href = m[1];
    if (href && !href.startsWith("#") && !href.startsWith("mailto:") && !href.startsWith("tel:")) {
      out.push(href);
    }
    m = re.exec(html);
  }
  return out;
}

function urlToSlug(url: string, sourceUrl: string): string {
  const u = new URL(url);
  const sourcePath = new URL(sourceUrl).pathname.replace(/\/$/, "");
  let slug = u.pathname.slice(sourcePath.length).replace(/^\//, "").replace(/\/$/, "");
  if (slug === "") slug = "home";
  // Normalize for cms `slug` constraint: lowercase + a-z0-9- only.
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

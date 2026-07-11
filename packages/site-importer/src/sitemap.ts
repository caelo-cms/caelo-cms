// SPDX-License-Identifier: MPL-2.0

/**
 * issue #192 — sitemap discovery for the import crawler.
 *
 * A link-only BFS under-crawls real sites (pagination-hidden posts,
 * unlinked landing pages) and wastes budget re-discovering what the
 * site already lists. Sitemap URLs seed the queue before BFS starts.
 *
 * Linear <loc> extraction (indexOf loops, no regex over the document)
 * per the #113 ReDoS discipline; sitemap indexes are followed one
 * level deep with a child cap.
 */

/** Raw text fetch used for robots.txt + sitemap XML (injectable). */
export type TextFetcher = (
  url: string,
) => Promise<{ ok: boolean; body: string; contentType: string }>;

const MAX_CHILD_SITEMAPS = 10;

/** Extract <loc>…</loc> values linearly. */
export function extractLocValues(xml: string, cap: number): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < cap) {
    const open = xml.indexOf("<loc>", from);
    if (open === -1) break;
    const close = xml.indexOf("</loc>", open);
    if (close === -1) break;
    const value = xml.slice(open + 5, close).trim();
    if (value.length > 0) out.push(value);
    from = close + 6;
  }
  return out;
}

export interface SitemapDiscovery {
  /** Same-host page URLs, deduped, capped at maxUrls. */
  readonly urls: readonly string[];
  readonly truncated: boolean;
  /** Which sitemap documents were read (for run forensics). */
  readonly sources: readonly string[];
}

/**
 * Discover page URLs from `<origin>/sitemap.xml` + any robots.txt
 * `Sitemap:` candidates. Cross-host entries are dropped (the crawl is
 * same-host by contract); fetch failures skip the candidate — sitemap
 * discovery is an accelerator, never a gate.
 */
export async function discoverSitemapUrls(args: {
  readonly origin: string;
  readonly fetcher: TextFetcher;
  readonly robotsSitemaps?: readonly string[];
  readonly maxUrls: number;
}): Promise<SitemapDiscovery> {
  const host = new URL(args.origin).host;
  const candidates = [
    ...(args.robotsSitemaps ?? []),
    new URL("/sitemap.xml", args.origin).toString(),
  ];
  const seenDocs = new Set<string>();
  const urls = new Set<string>();
  const sources: string[] = [];
  let truncated = false;

  const readDoc = async (docUrl: string, allowIndex: boolean): Promise<void> => {
    if (seenDocs.has(docUrl) || urls.size >= args.maxUrls) return;
    seenDocs.add(docUrl);
    let res: Awaited<ReturnType<TextFetcher>>;
    try {
      res = await args.fetcher(docUrl);
    } catch {
      return;
    }
    if (!res.ok || res.body.length === 0) return;
    sources.push(docUrl);
    const isIndex = res.body.includes("<sitemapindex");
    const locs = extractLocValues(res.body, args.maxUrls * 2);
    if (isIndex) {
      if (!allowIndex) return; // one level of nesting only
      for (const child of locs.slice(0, MAX_CHILD_SITEMAPS)) {
        await readDoc(child, false);
      }
      if (locs.length > MAX_CHILD_SITEMAPS) truncated = true;
      return;
    }
    for (const loc of locs) {
      if (urls.size >= args.maxUrls) {
        truncated = true;
        break;
      }
      try {
        const u = new URL(loc);
        if (u.host !== host) continue;
        urls.add(`${u.origin}${u.pathname.replace(/\/$/, "") || "/"}`);
      } catch {
        // invalid loc — skip
      }
    }
  };

  for (const c of candidates) {
    await readDoc(c, true);
  }
  return { urls: [...urls], truncated, sources };
}

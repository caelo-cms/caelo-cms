// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — same-domain BFS crawler. Bounded by depth + maxPages. Polite:
 *   - throttled request starts (robots.txt Crawl-delay raises the floor)
 *   - one User-Agent string identifying as Caelo importer
 *   - declines redirects to a different host
 *   - skips non-text/html responses
 *   - honours robots.txt Disallow for our UA (issue #192; fail-open on
 *     fetch error — an unreachable robots.txt must not veto a crawl the
 *     site owner requested)
 *
 * issue #192 — hardened for real migrations:
 *   - sitemap.xml (+ robots `Sitemap:` lines) seeds the queue so
 *     pagination-hidden pages are found without deep link-chasing
 *   - streaming: `onBatch` flushes extracted pages incrementally and
 *     the crawler stops accumulating in memory
 *   - resumability: `onCheckpoint` emits the full frontier
 *     (queue/seen/counters/errors); `resumeFrom` restores it, so a
 *     crashed worker continues instead of restarting (the DB's
 *     UNIQUE(run_id, source_url) makes replayed batches idempotent)
 *   - bounded concurrency: N parallel fetches sharing one polite
 *     request-start gate (same-host politeness stays intact)
 */

import {
  extractModulesFromHtml,
  extractPageCss,
  extractThemeTokens,
  extractTitle,
} from "./extractor.js";
import { computePageSignature } from "./page-signature.js";
import { isPathAllowed, parseRobotsTxt, type RobotsRules } from "./robots.js";
import { isExternalUrlBlockedError, safeExternalFetch } from "./safe-fetch.js";
import { discoverSitemapUrls, type TextFetcher } from "./sitemap.js";

export interface CrawlCheckpoint {
  readonly queue: ReadonlyArray<{ url: string; depth: number }>;
  readonly seen: readonly string[];
  readonly pagesCrawled: number;
  readonly errors: ReadonlyArray<{ url: string; reason: string }>;
}

export interface CrawlOptions {
  readonly sourceUrl: string;
  /** BFS depth from the source URL. Default 2. */
  readonly depth?: number;
  /** Hard ceiling on total pages crawled. Default 50. */
  readonly maxPages?: number;
  /** Minimum ms between request STARTS. Default 100; robots.txt
   *  Crawl-delay raises it. */
  readonly throttleMs?: number;
  /** Optional fetch override for tests. */
  readonly fetcher?: (url: string) => Promise<{ ok: boolean; html: string; contentType: string }>;
  /** issue #192 — raw-text fetch for robots.txt + sitemap XML
   *  (injectable for tests; defaults to the guarded fetch). */
  readonly textFetcher?: TextFetcher;
  /**
   * issue #191 — exact hostnames exempt from the SSRF guard's
   * public-address check (test fixtures, deliberate private crawls).
   * Ignored when a custom `fetcher` is injected.
   */
  readonly allowedHosts?: readonly string[];
  /** issue #192 — sitemap seeding. Default true. */
  readonly useSitemap?: boolean;
  /** issue #192 — robots.txt Disallow/Crawl-delay. Default true. */
  readonly respectRobots?: boolean;
  /** issue #192 — restore a checkpointed frontier instead of seeding. */
  readonly resumeFrom?: CrawlCheckpoint;
  /** issue #192 — incremental flush. When set, `CrawlResult.pages`
   *  stays EMPTY (memory stays bounded); every extracted batch goes
   *  here instead. */
  readonly onBatch?: (pages: CrawledPage[]) => Promise<void>;
  /** issue #192 — frontier persistence, called after every batch. */
  readonly onCheckpoint?: (cp: CrawlCheckpoint) => Promise<void>;
  /** Pages per onBatch/onCheckpoint flush. Default 25. */
  readonly batchSize?: number;
  /** Parallel fetches. Default 4. */
  readonly concurrency?: number;
}

export interface CrawledPage {
  readonly url: string;
  readonly proposedSlug: string;
  readonly title: string;
  readonly modules: ReturnType<typeof extractModulesFromHtml>;
  readonly themeTokens: Record<string, string>;
  /** issue #194 — deterministic structural signature ("home" for the
   *  source URL); equal signatures form one page-type cluster. */
  readonly signature: string;
  /** issue #195 — the page's <style> contents; compose attaches it to
   *  the cluster template so imported pages keep their design. */
  readonly pageCss: string;
}

export interface CrawlResult {
  /** Empty when `onBatch` streams pages out instead. */
  readonly pages: CrawledPage[];
  readonly seenCount: number;
  readonly pagesCrawled: number;
  readonly errors: ReadonlyArray<{ url: string; reason: string }>;
}

const USER_AGENT = "CaleoSiteImporter/1.0 (+https://caleo-cms.com/imports — research-only crawler)";
const UA_TOKEN = "caleositeimporter";

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const depth = opts.depth ?? 2;
  const maxPages = opts.maxPages ?? 50;
  const batchSize = opts.batchSize ?? 25;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const fetcher = opts.fetcher ?? makeDefaultFetcher(opts.allowedHosts ?? []);
  // A custom HTML fetcher without a matching text fetcher means a
  // hermetic test harness — don't reach for the real network for
  // robots/sitemap behind its back.
  const textFetcher =
    opts.textFetcher ?? (opts.fetcher ? null : makeDefaultTextFetcher(opts.allowedHosts ?? []));

  const sourceParsed = new URL(opts.sourceUrl);
  const seen = new Set<string>(opts.resumeFrom?.seen ?? []);
  const queue: Array<{ url: string; depth: number }> = opts.resumeFrom
    ? [...opts.resumeFrom.queue]
    : [{ url: opts.sourceUrl, depth: 0 }];
  const errors: Array<{ url: string; reason: string }> = [...(opts.resumeFrom?.errors ?? [])];
  let pagesCrawled = opts.resumeFrom?.pagesCrawled ?? 0;

  // ── Politeness rules (fetched fresh even on resume — cheap, and the
  //    rules may have changed while the run sat crashed) ─────────────
  let robots: RobotsRules | null = null;
  if (opts.respectRobots !== false && textFetcher) {
    try {
      const res = await textFetcher(new URL("/robots.txt", sourceParsed.origin).toString());
      if (res.ok) robots = parseRobotsTxt(res.body, UA_TOKEN);
    } catch {
      // fail-open, but visibly: the run's error list names it.
      errors.push({
        url: `${sourceParsed.origin}/robots.txt`,
        reason: "robots.txt unreachable — proceeding without rules",
      });
    }
  }
  const throttle = Math.max(opts.throttleMs ?? 100, robots?.crawlDelayMs ?? 0);

  // ── Sitemap seeding (fresh crawls only — a resumed frontier already
  //    contains whatever the sitemap contributed) ────────────────────
  if (opts.useSitemap !== false && !opts.resumeFrom && textFetcher) {
    const discovered = await discoverSitemapUrls({
      origin: sourceParsed.origin,
      fetcher: textFetcher,
      robotsSitemaps: robots?.sitemaps ?? [],
      maxUrls: maxPages,
    });
    for (const url of discovered.urls) {
      if (url !== opts.sourceUrl) queue.push({ url, depth: 1 });
    }
  }

  const pages: CrawledPage[] = [];
  let batch: CrawledPage[] = [];
  let sinceFlush = 0;

  const flush = async (): Promise<void> => {
    if (opts.onBatch && batch.length > 0) {
      const toSend = batch;
      batch = [];
      await opts.onBatch(toSend);
    }
    if (opts.onCheckpoint) {
      await opts.onCheckpoint({
        queue: [...queue],
        seen: [...seen],
        pagesCrawled,
        errors: [...errors],
      });
    }
    sinceFlush = 0;
  };

  // Shared polite gate: request STARTS are spaced by `throttle` across
  // all workers, so concurrency shortens tail latency (slow pages don't
  // serialise the queue) without hammering the host.
  let nextStartAt = 0;
  const politeWait = async (): Promise<void> => {
    const now = Date.now();
    const wait = Math.max(0, nextStartAt - now);
    nextStartAt = Math.max(now, nextStartAt) + throttle;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  const processOne = async (next: { url: string; depth: number }): Promise<void> => {
    if (robots) {
      const path = new URL(next.url).pathname;
      if (!isPathAllowed(robots, path)) {
        errors.push({ url: next.url, reason: "robots-disallowed" });
        return;
      }
    }
    await politeWait();
    let res: { ok: boolean; html: string; contentType: string };
    try {
      res = await fetcher(next.url);
    } catch (e) {
      // A blocked ROOT URL means the whole crawl is pointless — fail the
      // run loudly (no-fallbacks pre-1.0) instead of returning an empty
      // "ready for review" result. Blocked in-site links merely record.
      if (next.depth === 0 && isExternalUrlBlockedError(e)) throw e;
      errors.push({ url: next.url, reason: (e as Error).message });
      return;
    }
    if (!res.ok) {
      errors.push({ url: next.url, reason: "non-OK status" });
      return;
    }
    if (!res.contentType.includes("text/html")) {
      errors.push({ url: next.url, reason: `skipped non-html (${res.contentType})` });
      return;
    }
    const page: CrawledPage = {
      url: next.url,
      proposedSlug: urlToSlug(next.url, opts.sourceUrl),
      title: extractTitle(res.html),
      modules: extractModulesFromHtml(res.html),
      themeTokens: extractThemeTokens(res.html),
      signature: computePageSignature({ url: next.url, sourceUrl: opts.sourceUrl, html: res.html }),
      pageCss: extractPageCss(res.html),
    };
    pagesCrawled += 1;
    sinceFlush += 1;
    if (opts.onBatch) batch.push(page);
    else pages.push(page);

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
  };

  // Worker pool over the shared queue. Workers claim (and mark seen)
  // synchronously before awaiting, so no URL is fetched twice.
  const worker = async (): Promise<void> => {
    while (pagesCrawled < maxPages) {
      const next = queue.shift();
      if (!next) return;
      if (seen.has(next.url)) continue;
      seen.add(next.url);
      await processOne(next);
      if (sinceFlush >= batchSize) await flush();
    }
  };

  // The ROOT must be processed alone first: it decides loud-abort on a
  // blocked source and feeds the first links before workers fan out.
  if (!opts.resumeFrom && queue.length > 0 && pagesCrawled === 0) {
    const root = queue.shift();
    if (root && !seen.has(root.url)) {
      seen.add(root.url);
      await processOne(root);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await flush();

  return { pages, seenCount: seen.size, pagesCrawled, errors };
}

/**
 * issue #191 — the default fetcher routes through the SSRF guard
 * (connect-time DNS validation, re-validated redirects, byte cap) and
 * keeps the documented "declines redirects to a different host" policy
 * by checking the post-redirect final URL.
 */
function makeDefaultFetcher(
  allowedHosts: readonly string[],
): (url: string) => Promise<{ ok: boolean; html: string; contentType: string }> {
  return async (url: string) => {
    const res = await safeExternalFetch(url, {
      allowedHosts,
      headers: { "User-Agent": USER_AGENT },
      maxBytes: 2 * 1024 * 1024,
    });
    if (new URL(res.finalUrl).host !== new URL(url).host) {
      return { ok: false, html: "", contentType: "redirected-off-host" };
    }
    if (!res.ok || !res.contentType.includes("text/html")) {
      return { ok: res.ok, html: "", contentType: res.contentType };
    }
    return { ok: true, html: res.bodyText, contentType: res.contentType };
  };
}

/** issue #192 — guarded raw-text fetch for robots.txt / sitemap XML. */
function makeDefaultTextFetcher(allowedHosts: readonly string[]): TextFetcher {
  return async (url: string) => {
    const res = await safeExternalFetch(url, {
      allowedHosts,
      headers: { "User-Agent": USER_AGENT },
      maxBytes: 1024 * 1024,
    });
    return { ok: res.ok, body: res.bodyText, contentType: res.contentType };
  };
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

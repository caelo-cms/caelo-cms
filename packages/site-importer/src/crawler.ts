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
  /** BFS depth from the source URL. Default 2. Ignored in LIST mode. */
  readonly depth?: number;
  /** Hard ceiling on total pages crawled. Default 50. Ignored in LIST mode. */
  readonly maxPages?: number;
  /**
   * issue #229 — LIST mode. When set (non-empty), the crawler fetches
   * EXACTLY these URLs (+ `sourceUrl` for origin scoping) — no BFS, no
   * depth expansion, no sitemap seeding. Off-origin / unparseable URLs
   * are dropped into `errors`, never fetched (SSRF-safe). Every fetched
   * URL still passes the same-origin + robots + hardened-fetch gates and
   * the identical per-page extraction pipeline; list mode only changes
   * WHICH URLs are fetched. Mutually exclusive with depth/BFS at the
   * propose boundary; here a present `urls` simply wins.
   */
  readonly urls?: readonly string[];
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
  readonly modules: ReturnType<typeof extractModulesFromHtml>["modules"];
  /** run #10 D3 — loud counter: comment-thread subtrees the extractor
   *  removed (WP `#comments`, `.comment-list`, `#respond`, …). The
   *  orchestrator persists it as a visible `comments-stripped:<n>`
   *  import-page note; it must never vanish silently. */
  readonly commentsStripped: number;
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

// ASCII ONLY: header values reject non-Latin-1 at the socket layer —
// the original em-dash here made EVERY real fetch (pages, robots.txt,
// sitemap.xml) throw "Invalid character in header content" while the
// injected-fetcher tests sailed past it.
export const USER_AGENT =
  "CaleoSiteImporter/1.0 (+https://caleo-cms.com/imports; research-only crawler)";
const UA_TOKEN = "caleositeimporter";

/**
 * issue #229 — the normalised, deduped, same-origin URL set for LIST
 * mode. `urls` starts with the source origin (so origin scoping always
 * has a root) and preserves the AI's chosen order after it; `skipped`
 * names every off-origin or unparseable entry so the run's error list
 * surfaces them (no silent drops — CLAUDE.md §2 no-fallbacks).
 */
export interface ListModeResolution {
  readonly urls: string[];
  readonly skipped: Array<{ url: string; reason: string }>;
}

/** Strip the hash + ALL trailing slashes so `/a/`, `/a//` and `/a#top`
 *  dedupe to one key (the root collapses to `/`); query strings are
 *  PRESERVED (an explicit `?page=2` pick is a distinct page the AI chose
 *  on purpose). */
function normalizeListUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString();
}

/**
 * Pure resolver for LIST mode: normalise + dedupe the chosen URLs, drop
 * anything not on the source origin (or unparseable) into `skipped`, and
 * guarantee the source origin leads the list so the crawl always has a
 * scoping root even if the AI forgot to include the homepage.
 *
 * @param sourceUrl the run's source URL — defines the allowed origin.
 * @param urls the AI-chosen absolute URLs to fetch.
 */
export function resolveListModeUrls(
  sourceUrl: string,
  urls: readonly string[],
): ListModeResolution {
  const sourceNorm = normalizeListUrl(sourceUrl);
  const sourceOrigin = new URL(sourceNorm).origin;
  const out: string[] = [sourceNorm];
  const seen = new Set<string>([sourceNorm]);
  const skipped: Array<{ url: string; reason: string }> = [];
  for (const raw of urls) {
    let norm: string;
    try {
      norm = normalizeListUrl(raw);
    } catch {
      skipped.push({ url: raw, reason: "list-mode: unparseable URL" });
      continue;
    }
    if (new URL(norm).origin !== sourceOrigin) {
      skipped.push({
        url: raw,
        reason: "list-mode: off-origin URL (not same origin as sourceUrl)",
      });
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return { urls: out, skipped };
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  // issue #229 — LIST mode fetches exactly the chosen URLs (+ source
  // origin), so depth expansion is off (depth 0) and the page ceiling is
  // the resolved list length; sitemap seeding is skipped below.
  const listMode = !!(opts.urls && opts.urls.length > 0);
  const listResolved = listMode ? resolveListModeUrls(opts.sourceUrl, opts.urls ?? []) : null;
  const depth = listMode ? 0 : (opts.depth ?? 2);
  const maxPages = listMode ? (listResolved?.urls.length ?? 0) : (opts.maxPages ?? 50);
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
  // LIST mode seeds the frontier from the resolved URL set (all at depth
  // 0, so no expansion); depth mode seeds from the single source URL and
  // grows via BFS + sitemap.
  const queue: Array<{ url: string; depth: number }> = opts.resumeFrom
    ? [...opts.resumeFrom.queue]
    : listResolved
      ? listResolved.urls.map((url) => ({ url, depth: 0 }))
      : [{ url: opts.sourceUrl, depth: 0 }];
  const errors: Array<{ url: string; reason: string }> = [
    ...(opts.resumeFrom?.errors ?? []),
    // Off-origin / unparseable list entries are recorded once (fresh
    // runs only — a resumed frontier already carries them).
    ...(!opts.resumeFrom && listResolved ? listResolved.skipped : []),
  ];
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

  // ── Sitemap seeding (fresh DEPTH crawls only — LIST mode fetches an
  //    exact set, and a resumed frontier already contains whatever the
  //    sitemap contributed) ─────────────────────────────────────────
  if (opts.useSitemap !== false && !listMode && !opts.resumeFrom && textFetcher) {
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
    const extraction = extractModulesFromHtml(res.html);
    const page: CrawledPage = {
      url: next.url,
      proposedSlug: urlToSlug(next.url, opts.sourceUrl),
      title: extractTitle(res.html),
      modules: extraction.modules,
      commentsStripped: extraction.commentsStripped,
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

/**
 * Derives a Caelo page slug from a crawled URL, relative to the crawl
 * root. The crawl root's own path (e.g. a locale prefix like `/en`)
 * is stripped ONLY when the crawled URL actually lives under it.
 *
 * Run #9 regression: a crawl rooted at `https://site.com/en/` blindly
 * sliced `sourcePath.length` chars off EVERY pathname, so pages
 * outside the prefix lost their leading characters — `/tools` → `ols`,
 * `/pricing` → `icing`, `/blog` → `og` (23 mangled pages, surfacing
 * later as "redirect /tools → /ols would shadow the existing page").
 * Paths that don't start with the root prefix now keep their full
 * pathname.
 *
 * @param url absolute URL of the crawled page.
 * @param sourceUrl the crawl root URL whose path acts as the prefix.
 * @returns a cms-safe slug (`a-z0-9-`), `"home"` for the root itself.
 */
export function urlToSlug(url: string, sourceUrl: string): string {
  const u = new URL(url);
  const sourcePath = new URL(sourceUrl).pathname.replace(/\/$/, "");
  let path = u.pathname;
  if (sourcePath !== "" && (path === sourcePath || path.startsWith(`${sourcePath}/`))) {
    path = path.slice(sourcePath.length);
  }
  let slug = path.replace(/^\//, "").replace(/\/$/, "");
  if (slug === "") slug = "home";
  // Normalize for cms `slug` constraint: lowercase + a-z0-9- only.
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

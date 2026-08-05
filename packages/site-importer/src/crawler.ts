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

import type { ElementStyleSample } from "./design-tokens.js";
import {
  extractModulesFromHtml,
  extractPageCss,
  extractThemeTokens,
  extractTitle,
} from "./extractor.js";
import { computePageSignature } from "./page-signature.js";
import { fetchRenderedHtml } from "./rendered-fetch.js";
import { isPathAllowed, parseRobotsTxt, type RobotsRules } from "./robots.js";
import { assertPublicHttpUrl, isExternalUrlBlockedError, safeExternalFetch } from "./safe-fetch.js";
import {
  createPlaywrightScreenshotter,
  type Screenshot,
  type Screenshotter,
} from "./screenshot.js";
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
  /**
   * issue #423 — injectable browser seam. When set, the crawler renders +
   * captures through THIS screenshotter instead of launching its own
   * Playwright (the caller owns disposal). `null` forces the static
   * fetch-only path. Ignored when a custom `fetcher` is injected.
   */
  readonly screenshotter?: Screenshotter | null;
  /**
   * issue #423 — per-page visual ground truth, streamed OUT as soon as
   * each page is accepted so PNG bytes are never accumulated across a
   * batch. Fired only for pages that actually enter the crawl result
   * (after the HTML/robots/origin gates). A throwing sink is recorded in
   * `errors` — loud, but it never blocks the crawl (epic #252 ruling).
   */
  readonly onPageCapture?: (item: { url: string; screenshot: Screenshot }) => Promise<void>;
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
  /** issue #423 — computed-style samples from the SAME render session
   *  that produced the page's HTML (and its `onPageCapture` screenshot).
   *  Absent on fetch-only crawls and when the capture attempt failed —
   *  the post-crawl ground-truth pass then retries + notes loudly. */
  readonly styleSamples?: readonly ElementStyleSample[];
}

export interface CrawlResult {
  /** Empty when `onBatch` streams pages out instead. */
  readonly pages: CrawledPage[];
  readonly seenCount: number;
  readonly pagesCrawled: number;
  readonly errors: ReadonlyArray<{ url: string; reason: string }>;
}

/**
 * issue #423 — internal per-page fetch result. A superset of the public
 * `opts.fetcher` shape ({ok, html, contentType}) so injected test fetchers
 * keep working unchanged; the capture-first rendered path additionally
 * carries the visual ground truth from the SAME render session.
 */
interface PageFetchResult {
  readonly ok: boolean;
  readonly html: string;
  readonly contentType: string;
  /** Computed-style samples (#247 ground truth) from the render session. */
  readonly styleSamples?: readonly ElementStyleSample[];
  /** Source screenshot from the render session — handed straight to
   *  `onPageCapture`, never buffered across a batch. */
  readonly screenshot?: Screenshot;
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

  // Render-first (docs: rendered-first plan): with no injected fetcher, run
  // each page's JS so the crawl captures the DOM the browser BUILDS — a
  // JS-set image/video src, a JS-built nav, sections injected on load — not
  // the pre-JS source. ONE Chromium is launched here and reused across the
  // whole crawl (contexts are per-page); it is disposed in the finally below.
  // Falls back to a static fetch per page (with a loud note in the fetcher)
  // when Chromium is unavailable. Tests inject `opts.fetcher` and never render.
  //
  // issue #423 — the render is now CAPTURE-FIRST: the same session that
  // yields the page's rendered HTML also takes the source screenshot and
  // samples computed styles (the #247 ground truth), so LIST-mode and
  // discovery crawls stop re-rendering every page in a second pass.
  let screenshotter: Screenshotter | null = null;
  // Only a crawler-launched browser is disposed here — an injected one
  // belongs to the caller (it may span several crawls).
  let ownsScreenshotter = false;
  let fetcher: ((url: string) => Promise<PageFetchResult>) | undefined = opts.fetcher;
  if (!fetcher) {
    // Loud-abort a blocked SOURCE before spending a Chromium launch on it —
    // the crawler's "root-blocked crawls fail loudly" contract, kept fast.
    assertPublicHttpUrl(opts.sourceUrl, { allowedHosts: opts.allowedHosts ?? [] });
    if (opts.screenshotter !== undefined) {
      screenshotter = opts.screenshotter;
    } else {
      screenshotter = await createPlaywrightScreenshotter({
        allowedHosts: opts.allowedHosts ?? [],
      });
      ownsScreenshotter = true;
    }
    fetcher = makeCaptureFetcher(screenshotter, opts.allowedHosts ?? []);
  }
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

  // Definite after the setup above; a const alias keeps the closure's type
  // narrow without relying on flow analysis across the worker closures.
  const pageFetcher = fetcher;

  const processOne = async (next: { url: string; depth: number }): Promise<void> => {
    if (robots) {
      const path = new URL(next.url).pathname;
      if (!isPathAllowed(robots, path)) {
        errors.push({ url: next.url, reason: "robots-disallowed" });
        return;
      }
    }
    await politeWait();
    let res: PageFetchResult;
    try {
      res = await pageFetcher(next.url);
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
      ...(res.styleSamples ? { styleSamples: res.styleSamples } : {}),
    };
    // issue #423 — hand the pixels to the sink NOW (bytes must not sit in
    // the batch buffer). A failing sink is a persistence problem, not a
    // crawl problem: record it loudly and keep going — the page stays
    // keyless, so the post-crawl ground-truth pass re-attempts + notes it.
    if (res.screenshot && opts.onPageCapture) {
      try {
        await opts.onPageCapture({ url: next.url, screenshot: res.screenshot });
      } catch (e) {
        errors.push({
          url: next.url,
          // Coerce non-Error throws too — an empty "failed:" reason in the
          // run report would defeat the loud-marker purpose.
          reason: `screenshot persistence failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
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

  try {
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
  } finally {
    // Release the shared Chromium — but only when THIS crawl launched it.
    // An injected screenshotter (issue #423 test seam / a caller reusing
    // one browser across crawls) is the caller's to dispose. Best-effort:
    // a dispose failure must not mask a crawl result or a real error.
    if (ownsScreenshotter) await screenshotter?.dispose().catch(() => undefined);
  }
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

/**
 * Capture-first crawl fetcher (issue #423, supersedes the render-only
 * fetcher): ONE Playwright session per page yields the rendered HTML the
 * extractors consume AND the #247 visual ground truth (source screenshot +
 * computed-style samples) — LIST-mode and discovery crawls no longer need a
 * second render pass for capture.
 *
 * Failure ladder (ratified: epic #252, operator ruling 2026-07-12 — a
 * screenshot failure must never block the run):
 *   1. `capture` throws → fall back to `fetchRenderedHtml` for CONTENT
 *      (itself render-then-static). The page crawls without pixels; the
 *      post-crawl ground-truth pass retries capture + notes it loudly.
 *   2. `screenshotter` null (Chromium unavailable) → the plain SSRF-guarded
 *      static fetcher — the loud, expected fetch-only degrade.
 * Preserves the default fetcher's contract: same-origin redirects only,
 * non-HTML gated (via the capture's navigation `contentType`).
 */
function makeCaptureFetcher(
  screenshotter: Screenshotter | null,
  allowedHosts: readonly string[],
): (url: string) => Promise<PageFetchResult> {
  // No Chromium → the plain SSRF-guarded static fetcher (keeps the crawler
  // User-Agent + same-host policy). This is the loud, expected degrade.
  const staticFetcher = makeDefaultFetcher(allowedHosts);
  return async (url: string) => {
    if (!screenshotter) return staticFetcher(url);

    let shot: Screenshot | null = null;
    try {
      shot = await screenshotter.capture(url, {
        external: true,
        sampleStyles: true,
        captureHtml: true,
      });
    } catch (e) {
      // A blocked URL is a hard stop — the same SSRF policy would reject it
      // on the fallback path too, less clearly. Everything else degrades to
      // the content-only fallback below.
      if (isExternalUrlBlockedError(e)) throw e;
      shot = null;
    }

    if (shot && shot.renderedHtml !== undefined) {
      // Non-HTML gate, same policy as `fetchRenderedHtml`: only gate when
      // the response actually reported a type (undefined = trust it) — a
      // PDF/image navigates into a viewer whose DOM is not the resource.
      // `ok: true` on purpose: the navigation succeeded, so the crawler's
      // content-type check reports the informative "skipped non-html
      // (<type>)" instead of a misleading "non-OK status".
      if (shot.contentType !== undefined && !shot.contentType.includes("text/html")) {
        return { ok: true, html: "", contentType: shot.contentType };
      }
      if (shot.finalUrl && new URL(shot.finalUrl).host !== new URL(url).host) {
        return { ok: false, html: "", contentType: "redirected-off-host" };
      }
      return {
        ok: true,
        html: shot.renderedHtml,
        contentType: "text/html",
        screenshot: shot,
        ...(shot.styleSamples ? { styleSamples: shot.styleSamples } : {}),
      };
    }

    // Capture failed — content still crawls (render-then-static), and when
    // the fallback render succeeds we keep its style samples: tokens
    // without pixels beat no ground truth at all (mirrors the after-pass's
    // "upload failed but tokens still written" behaviour).
    const rf = await fetchRenderedHtml(url, {
      screenshotter,
      allowedHosts,
      maxBytes: 2 * 1024 * 1024,
      sampleStyles: true,
    });
    if (!rf.ok) {
      return { ok: false, html: "", contentType: rf.contentType ?? "fetch-error" };
    }
    if (new URL(rf.finalUrl).host !== new URL(url).host) {
      return { ok: false, html: "", contentType: "redirected-off-host" };
    }
    return {
      ok: true,
      html: rf.html,
      contentType: "text/html",
      ...(rf.styleSamples ? { styleSamples: rf.styleSamples } : {}),
    };
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

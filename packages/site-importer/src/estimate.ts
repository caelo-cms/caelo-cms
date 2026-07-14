// SPDX-License-Identifier: MPL-2.0

/**
 * issue #193 — crawl-scope + cost estimation for the propose gate.
 *
 * §11.A requires the proposal preview to be a blast-radius summary,
 * and for a migration the page count IS the blast radius: crawl time
 * and AI rebuild spend both scale with it. The estimator is cheap
 * (one sitemap read, or one homepage read when no sitemap exists) and
 * time-capped so proposing stays snappy; a failed estimate is stored
 * LOUDLY as {failed, reason} — the Owner then approves knowing the
 * scope is unknown, which is itself information.
 *
 * issue #298 — this module estimates SCOPE only (page count, basis,
 * crawl time). It no longer prices the AI rebuild: the old
 * pages × $0.02–$0.10 heuristic was 15–65× under run #15's real cost
 * (`run-logs/run15-analysis.md`). Pricing needs the operator's current
 * ai_pricing rates, which live behind the Query API — so the propose
 * tool fills `aiCostUsd` from admin-core's calls×context model
 * (ai/import-cost-model.ts) after scoping; this package emits
 * `aiCostUsd: null` plus a loud `costNote` when unpriced.
 */

import { safeExternalFetch } from "./safe-fetch.js";
import { discoverSitemapUrls, type TextFetcher } from "./sitemap.js";

/** Mean seconds per crawled page: 100ms politeness + fetch + extract. */
const EST_SECONDS_PER_PAGE = 0.6;
/** No sitemap → same-host links on the homepage × this factor. */
const SAMPLE_EXTRAPOLATION_FACTOR = 3;

export type CrawlScopeEstimate =
  | { readonly failed: true; readonly reason: string }
  | {
      readonly failed?: false;
      readonly pages: number;
      /** issue #229 — `list` = the exact page-list mode (`propose_site_import`
       *  with `urls`): the count is not an estimate, it IS the list length. */
      readonly basis: "sitemap" | "sample" | "list";
      readonly truncated: boolean;
      readonly crawlMinutes: number;
      /** issue #298 — priced by the propose tool (calls×context model at
       *  the current ai_pricing rates); null while unpriced, with the
       *  reason in `costNote`. */
      readonly aiCostUsd: { readonly low: number; readonly high: number } | null;
      /** Loud reason whenever `aiCostUsd` is null (no-fallbacks rule). */
      readonly costNote?: string;
      /** issue #298 — decision support behind the band: the call/token
       *  model the price came from. */
      readonly estimatedCalls?: number;
      readonly estimatedInputTokens?: number;
    };

export interface EstimateOptions {
  readonly sourceUrl: string;
  readonly allowedHosts?: readonly string[];
  /** Injectable for tests; defaults to the SSRF-guarded fetch. */
  readonly textFetcher?: TextFetcher;
  /** Overall wall-clock cap. Default 10s. */
  readonly timeoutMs?: number;
}

type ScopeSuccess = Exclude<CrawlScopeEstimate, { failed: true }>;

function scopeFor(pages: number): ScopeSuccess {
  return {
    pages,
    basis: "sitemap",
    truncated: false,
    crawlMinutes: Math.max(1, Math.round((pages * EST_SECONDS_PER_PAGE) / 60)),
    // issue #298 — unpriced here; the propose tool fills the band from the
    // calls×context model at the operator's current ai_pricing rates.
    aiCostUsd: null,
    costNote: "not yet priced — the propose tool prices scope at the current ai_pricing rates",
  };
}

/**
 * issue #229 — deterministic scope for LIST mode. No network work: the
 * page count IS the chosen URL-list length, so the "blast radius"
 * (§11.A) is exact rather than sampled. Reuses the same crawl-time shape
 * as the depth path so the Owner reads one consistent preview.
 *
 * @param urlCount number of explicit URLs the AI chose to fetch.
 */
export function estimateListScope(urlCount: number): ScopeSuccess {
  return { ...scopeFor(urlCount), basis: "list", truncated: false };
}

/** Count same-host <a href> paths on one page (crude size signal). */
function countSameHostPaths(html: string, baseUrl: string): number {
  const host = new URL(baseUrl).host;
  const paths = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m = re.exec(html);
  while (m !== null && paths.size < 2000) {
    const href = m[1];
    if (href && !href.startsWith("#") && !href.startsWith("mailto:") && !href.startsWith("tel:")) {
      try {
        const u = new URL(href, baseUrl);
        if (u.host === host) paths.add(u.pathname);
      } catch {
        // skip
      }
    }
    m = re.exec(html);
  }
  return paths.size;
}

export async function estimateCrawlScope(opts: EstimateOptions): Promise<CrawlScopeEstimate> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const allowedHosts = opts.allowedHosts ?? [];
  const textFetcher: TextFetcher =
    opts.textFetcher ??
    (async (url: string) => {
      const res = await safeExternalFetch(url, {
        allowedHosts,
        maxBytes: 1024 * 1024,
        timeoutMs: Math.max(1000, deadline - Date.now()),
      });
      return { ok: res.ok, body: res.bodyText, contentType: res.contentType };
    });

  try {
    const origin = new URL(opts.sourceUrl).origin;

    // Preferred basis: the sitemap — exact-ish and one fetch.
    const discovered = await discoverSitemapUrls({
      origin,
      fetcher: textFetcher,
      maxUrls: 5000,
    });
    if (discovered.urls.length > 0) {
      return {
        ...scopeFor(discovered.urls.length),
        basis: "sitemap",
        truncated: discovered.truncated,
      };
    }

    // Fallback basis: homepage link count, extrapolated and labelled
    // as rough — never dressed up as exact.
    const home = await textFetcher(opts.sourceUrl);
    if (!home.ok || !home.contentType.includes("text/html")) {
      return {
        failed: true,
        reason: `no sitemap.xml and the homepage answered ${home.ok ? home.contentType || "non-HTML" : "an error"}`,
      };
    }
    const linkCount = countSameHostPaths(home.body, opts.sourceUrl);
    const pages = Math.max(1, linkCount * SAMPLE_EXTRAPOLATION_FACTOR);
    return { ...scopeFor(pages), basis: "sample", truncated: false };
  } catch (e) {
    return { failed: true, reason: e instanceof Error ? e.message : String(e) };
  }
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — read the rendered HTML of every page of the staged build,
 * for the findings checks. Fetched from the same staged origin Lighthouse
 * audits (audit-worker.ts `resolveStagingOrigin`), so the checks see
 * exactly what Publish live would ship.
 *
 * A page that cannot be read is an error, never "no findings": a published
 * page staging does not serve is itself broken, and a check that silently
 * skipped it would pass the build.
 */

import type { StagedPage } from "./check.js";

/** Pages fetched at once — the staged origin may be a small loopback server. */
export const PAGE_FETCH_CONCURRENCY = 6;

/** Per-page fetch budget. */
export const PAGE_FETCH_TIMEOUT_MS = 20_000;

/** Larger pages are refused instead of being parsed (and stored) in full. */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export interface PageToFetch {
  readonly pageId: string;
  readonly path: string;
  readonly url: string;
  /** #849 — the designated 404 page (served at `/404.html`). */
  readonly notFoundPage?: true;
}

export interface PageFetchError {
  readonly pageId: string;
  readonly url: string;
  readonly code: string;
  readonly message: string;
}

export interface FetchedPages {
  readonly pages: readonly StagedPage[];
  readonly errors: readonly PageFetchError[];
}

async function fetchOne(
  page: PageToFetch,
  fetcher: typeof fetch,
): Promise<StagedPage | PageFetchError> {
  try {
    const res = await fetcher(page.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        pageId: page.pageId,
        url: page.url,
        code: "page-status",
        message: `staging answered ${res.status} for ${page.path} — a published page the staged build does not serve; Stage again, and if it persists check the page's template and path`,
      };
    }
    const html = await res.text();
    if (html.length > MAX_PAGE_BYTES) {
      return {
        pageId: page.pageId,
        url: page.url,
        code: "page-too-large",
        message: `${page.path} is ${html.length} bytes of HTML, more than the ${MAX_PAGE_BYTES} the checks read — shrink the page's inline content`,
      };
    }
    return {
      pageId: page.pageId,
      path: page.path,
      url: page.url,
      html,
      ...(page.notFoundPage ? { notFoundPage: true as const } : {}),
    };
  } catch (e) {
    return {
      pageId: page.pageId,
      url: page.url,
      code: "page-unreachable",
      message: `could not read ${page.path} from staging: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Fetch every page, at most `PAGE_FETCH_CONCURRENCY` at a time. The result
 * keeps the input order.
 *
 * @param fetcher - injectable for tests; the global `fetch` otherwise.
 */
export async function fetchStagedPages(
  pages: readonly PageToFetch[],
  fetcher: typeof fetch = fetch,
): Promise<FetchedPages> {
  const results: (StagedPage | PageFetchError)[] = new Array(pages.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const page = pages[i];
      if (page === undefined) return;
      results[i] = await fetchOne(page, fetcher);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PAGE_FETCH_CONCURRENCY, pages.length) }, () => worker()),
  );
  const fetched: StagedPage[] = [];
  const errors: PageFetchError[] = [];
  for (const r of results) {
    if ("html" in r) fetched.push(r);
    else errors.push(r);
  }
  return { pages: fetched, errors };
}

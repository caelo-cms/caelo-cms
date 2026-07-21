// SPDX-License-Identifier: MPL-2.0

/**
 * In-memory cache of external-page inspections, so a page is fetched /
 * rendered ONCE and follow-up tools reuse it via a `pageRef` handle
 * (docs/inspect-tooling-redesign.md §3).
 *
 * `inspect_external_page` stores the fetched HTML + extracted Markdown
 * here and returns the `pageRef`; `read_page_more` paginates the cached
 * Markdown and `query_page_html` (Phase 2) will run selectors against the
 * cached HTML — neither re-fetches. In-process only (subagents run in the
 * same process and share this cache by handle), session-scoped by key,
 * LRU-capped. An evicted `pageRef` simply misses → the caller re-fetches.
 */

/** A cached inspection: enough to paginate Markdown + query the HTML. */
export interface PageInspection {
  readonly url: string;
  /** The fetched (static) HTML — always present. */
  readonly html: string;
  readonly markdown: string;
  /** The RENDERED (JS-applied) HTML, present when a screenshot/tokens
   *  render happened for this page. query_page_html prefers it over the
   *  static `html` so selectors run against the real DOM. */
  readonly renderedHtml?: string;
}

const CACHE_CAP = 32;
/** pageRef → entry. Map insertion order is the LRU order (bump on access). */
const cache = new Map<string, PageInspection>();

/** Chars of Markdown returned per page/slice (~2K tokens). */
export const MARKDOWN_SLICE_CHARS = 8_000;

/** djb2 → base36, matching the chat-runner's note-signature style. */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = (h * 33) ^ input.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Cache an inspection and return its `pageRef`. The handle is
 * deterministic per (session, url), so re-inspecting the same page in the
 * same chat reuses the handle instead of minting a new one.
 */
export function putPageInspection(sessionId: string, entry: PageInspection): string {
  const pageRef = `pg_${hash(`${sessionId}\n${entry.url}`)}`;
  cache.delete(pageRef); // re-insert at MRU
  cache.set(pageRef, entry);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pageRef;
}

/** Fetch a cached inspection (bumping it to MRU), or null if evicted/absent. */
export function getPageInspection(pageRef: string): PageInspection | null {
  const entry = cache.get(pageRef);
  if (!entry) return null;
  cache.delete(pageRef);
  cache.set(pageRef, entry);
  return entry;
}

/**
 * Slice Markdown from `cursor` for one page. Returns the text plus the
 * next cursor (null when the end is reached).
 */
export function sliceMarkdown(
  markdown: string,
  cursor = 0,
): { text: string; nextCursor: number | null } {
  const start = Math.max(0, Math.min(cursor, markdown.length));
  const end = Math.min(markdown.length, start + MARKDOWN_SLICE_CHARS);
  return { text: markdown.slice(start, end), nextCursor: end < markdown.length ? end : null };
}

/** Test seam — drop all cached inspections. */
export function clearPageInspectionCacheForTests(): void {
  cache.clear();
}

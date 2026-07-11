// SPDX-License-Identifier: MPL-2.0

/**
 * issue #194 — deterministic structural signatures for crawled pages.
 *
 * "AI decides, code executes": the CODE computes a stable signature
 * per page and groups equal signatures into clusters; the AI then
 * names the clusters and the operator confirms in chat. No embedding
 * calls, no model in the loop — 45 blog posts sharing one layout
 * produce 45 identical signatures, which is the whole trick.
 *
 * A signature has two halves:
 *   - path shape: the URL directory ("/blog/*" for /blog/my-post) —
 *     CMS-generated sites key their templates by path prefix;
 *   - DOM shape: bucketed counts of structure-bearing tags — two
 *     product pages differ in text, not in how many sections/h2s/
 *     forms they render.
 *
 * All scans are linear (indexOf / bounded char-class regex) per the
 * #113 ReDoS discipline.
 */

const SHAPE_TAGS = ["h1", "h2", "h3", "section", "article", "form", "table", "ul", "img"] as const;

/** Bucket a raw count so ±1 element doesn't split a cluster. */
function bucket(n: number): string {
  if (n === 0) return "0";
  if (n === 1) return "1";
  if (n === 2) return "2";
  if (n <= 5) return "3-5";
  return "6+";
}

function countTag(lower: string, tag: string): number {
  let count = 0;
  let from = 0;
  const needle = `<${tag}`;
  while (true) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    // Reject prefix collisions (<ul> vs <u>, <h1> vs nothing here) by
    // checking the following char terminates the tag name.
    const nextCh = lower[at + needle.length];
    if (nextCh === ">" || nextCh === " " || nextCh === "\t" || nextCh === "\n" || nextCh === "/") {
      count += 1;
    }
    from = at + needle.length;
  }
  return count;
}

/** djb2 — tiny stable hash for the composite key. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * The URL's "directory" shape: /blog/my-post → /blog/*; / → /;
 * /about → /* (top-level leaves share a shape only when their DOM
 * agrees — the DOM half keeps /about and /pricing apart from posts).
 */
export function pathShape(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "/";
  return `/${[...segments.slice(0, -1), "*"].join("/")}`;
}

export interface PageSignatureInput {
  readonly url: string;
  readonly sourceUrl: string;
  readonly html: string;
}

/**
 * Compute the cluster signature. The HOMEPAGE (the crawl's source
 * URL, path-normalised) is always its own singleton cluster — it is
 * the design contract and never shares a template with anything.
 */
export function computePageSignature(input: PageSignatureInput): string {
  const normalise = (u: string): string => {
    const p = new URL(u);
    return `${p.origin}${p.pathname.replace(/\/$/, "") || "/"}`;
  };
  if (normalise(input.url) === normalise(input.sourceUrl)) return "home";

  const lower = input.html.toLowerCase();
  const domShape = SHAPE_TAGS.map((t) => `${t}:${bucket(countTag(lower, t))}`).join(",");
  return `${pathShape(input.url)}|${hash(domShape)}`;
}

export interface ClusterSummary {
  readonly clusterKey: string;
  readonly count: number;
  readonly memberIds: readonly string[];
}

/** Group rows by signature, largest cluster first (home always last-
 *  but-present regardless of size — callers render it separately). */
export function summariseClusters(
  rows: ReadonlyArray<{ id: string; clusterKey: string }>,
): ClusterSummary[] {
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const list = byKey.get(r.clusterKey) ?? [];
    list.push(r.id);
    byKey.set(r.clusterKey, list);
  }
  return [...byKey.entries()]
    .map(([clusterKey, memberIds]) => ({ clusterKey, count: memberIds.length, memberIds }))
    .sort((a, b) =>
      a.clusterKey === "home" ? 1 : b.clusterKey === "home" ? -1 : b.count - a.count,
    );
}

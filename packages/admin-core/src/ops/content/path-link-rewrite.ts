// SPDX-License-Identifier: MPL-2.0

/**
 * Pure link rewriting for page URL moves (slug change, reparent, subtree
 * move, plugin URL-shape change).
 *
 * A move is an exact old-path → new-path pair per page. A subtree move
 * lists every moved descendant explicitly, so matching is EXACT per path
 * (trailing slash, `?query` and `#fragment` tolerated and preserved) and
 * runs in ONE pass over the text: a link already rewritten can never be
 * rewritten a second time by an overlapping pair (parent and child both
 * in the move set), and `/about-us` never matches a move of `/about`.
 */

/** Old path → new path, both leading-slash, no trailing slash (except "/"). */
export type PathMoveMap = ReadonlyMap<string, string>;

/** Canonical key for a path: no trailing slash except for the root. */
export function normalizeMovePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "") || "/";
  return path;
}

/**
 * Build the lookup map from move pairs. Identity pairs are dropped, and
 * so is the site root: "/" links mean "the homepage", whichever page
 * holds that designation, so a page leaving "/" never drags them along.
 */
export function buildPathMoveMap(
  moves: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of moves) {
    const from = normalizeMovePath(m.from);
    const to = normalizeMovePath(m.to);
    if (from !== to && from !== "/") map.set(from, to);
  }
  return map;
}

/**
 * Rewrite one bare URL value (`/a/b`, `/a/b/`, `/a/b#x`, `/a/b?q=1`).
 * Returns the input unchanged when it does not name a moved page.
 */
export function rewritePathValue(value: string, map: PathMoveMap): string {
  const m = /^(\/[^?#\s"'<>]*)([?#][^\s"'<>]*)?$/.exec(value);
  if (!m) return value;
  const rawPath = m[1] as string;
  const tail = m[2] ?? "";
  const next = map.get(normalizeMovePath(rawPath));
  if (next === undefined) return value;
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith("/") && next !== "/";
  return `${next}${trailingSlash ? "/" : ""}${tail}`;
}

const HREF_RE = /(href=)(["'])(\/[^"'<>]*)\2/g;

/** Rewrite every `href="/…"` / `href='/…'` in an HTML fragment. */
export function rewritePathLinksInHtml(html: string, map: PathMoveMap): string {
  if (map.size === 0) return html;
  return html.replace(HREF_RE, (whole, prefix: string, quote: string, url: string) => {
    const next = rewritePathValue(url, map);
    return next === url ? whole : `${prefix}${quote}${next}${quote}`;
  });
}

/**
 * Walk a JSON value (content-instance values, structured-set items) and
 * rewrite every string that IS a moved page's URL or carries `href`s to
 * one. Returns the same reference when nothing changed.
 */
export function rewritePathLinksInJson(value: unknown, map: PathMoveMap): unknown {
  if (map.size === 0) return value;
  if (typeof value === "string") {
    const asValue = rewritePathValue(value, map);
    if (asValue !== value) return asValue;
    return value.includes("href=") ? rewritePathLinksInHtml(value, map) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = rewritePathLinksInJson(v, map);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = rewritePathLinksInJson(v, map);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

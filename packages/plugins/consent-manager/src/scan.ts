// SPDX-License-Identifier: MPL-2.0

/**
 * Find the third-party hosts a module reaches for.
 *
 * A module that embeds a YouTube player, a Google Map, or a font from a
 * CDN contacts that vendor the moment the page renders — before anyone
 * has agreed to anything, and without the module's author necessarily
 * realising. Nobody can be asked to keep that inventory by hand, so it
 * is derived from the module's own source.
 *
 * ## Deliberately over-inclusive
 *
 * The scanner reports every external host it can see and decides
 * nothing. A false positive costs one classification call; a false
 * negative ships an unasked request to a third party. The asymmetry is
 * the whole design, and it is why the caller treats an unclassified
 * host as withheld rather than as fine.
 */

/** Every URL-bearing position that causes a browser request. */
const URL_PATTERNS: ReadonlyArray<RegExp> = [
  // src / href / poster / data-src / action, quoted.
  /(?:src|href|poster|action|data-src|srcset)\s*=\s*["']([^"']+)["']/gi,
  // CSS url(...)
  /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  // fetch / XHR / import with a literal URL.
  /(?:fetch|open|import)\s*\(\s*["']([^"']+)["']/gi,
  // A bare absolute URL anywhere. Authoring lifts an embed's address
  // out of the markup into a field default or a content value, where it
  // sits as a plain JSON string with no `src=` around it — which is
  // precisely the modules this scanner exists for.
  /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi,
];

/**
 * Hosts that are not third parties in the sense that matters here:
 * they never reach another operator's server.
 */
function isFirstParty(url: string): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  if (url.startsWith("#") || url.startsWith("?")) return true;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (url.startsWith("mailto:") || url.startsWith("tel:")) return true;
  // A bare relative path (`img/x.png`) or a template placeholder that
  // has not been substituted yet.
  if (url.startsWith("{{")) return true;
  return !/^(?:https?:)?\/\//i.test(url) && !url.includes("://");
}

function hostOf(url: string): string | null {
  const withScheme = url.startsWith("//") ? `https:${url}` : url;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every external host referenced by a module's source, deduplicated and
 * sorted so a re-scan of unchanged source produces an identical list.
 *
 * @param sources the module's html, css and js — all three, because a
 *   `url()` in the stylesheet and a `fetch` in the script reach a
 *   vendor exactly as surely as an `<iframe src>` does.
 */
export function externalHosts(sources: { html?: string; css?: string; js?: string }): string[] {
  const found = new Set<string>();
  const blob = [sources.html ?? "", sources.css ?? "", sources.js ?? ""].join("\n");
  for (const pattern of URL_PATTERNS) {
    // Fresh lastIndex per use — a shared /g regex is stateful, and
    // reusing one mid-stream skips matches at random.
    const re = new RegExp(pattern.source, pattern.flags);
    let m = re.exec(blob);
    while (m !== null) {
      // The bare-URL pattern has no capture group; its whole match is
      // the URL.
      const raw = (m[1] ?? m[0] ?? "").trim();
      // srcset holds a comma-separated candidate list.
      for (const candidate of raw.split(",")) {
        const url = candidate.trim().split(/\s+/)[0] ?? "";
        if (url.length === 0 || isFirstParty(url)) continue;
        const host = hostOf(url);
        if (host) found.add(host);
      }
      m = re.exec(blob);
    }
  }
  return [...found].sort();
}

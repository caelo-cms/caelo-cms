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

/** Link relations that never make the browser fetch anything by themselves. */
const NON_LOADING_LINK_RELS = new Set([
  "canonical",
  "alternate",
  "author",
  "license",
  "help",
  "next",
  "prev",
  "search",
  "bookmark",
  "me",
]);

/** Attributes that make the browser fetch their URL as the page loads. */
const LOADING_ATTRS = new Set([
  "src",
  "srcset",
  "poster",
  "data",
  "data-src",
  "data-srcset",
  "background",
]);

/** XML namespace URIs fixed by spec. Identifiers only — browsers never fetch them. */
const STANDARD_XML_NAMESPACES: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/XML/1998/namespace",
]);

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PLACEHOLDER_RE = /\{\{\{?\s*[#^/>&]?\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}?\}\}/g;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/**
 * Whether an attribute makes the browser request its URL on page load.
 * A link (`<a href>`) is a navigation: nothing is contacted until
 * someone clicks, so it needs no consent. When the module ships its own
 * JavaScript, any non-link attribute may be what that script loads.
 */
function attrLoads(tag: string, attr: string, attrs: Map<string, string>, hasJs: boolean): boolean {
  const t = tag.toLowerCase();
  const a = attr.toLowerCase();
  // A STANDARD namespace declaration (`xmlns="http://www.w3.org/2000/svg"`)
  // is an identifier the parser compares, never an address anything
  // fetches. Counting it withheld every module with JS and an inline SVG
  // icon (the site header of the PR #641 homepage run) behind "www.w3.org".
  // Only the well-known URIs, matched exactly: any other `xmlns:*` value is
  // just an attribute the module's script can read and fetch
  // (`xmlns:telemetry="https://tracker.example/collect"`), so it is scanned.
  if (
    (a === "xmlns" || a.startsWith("xmlns:")) &&
    STANDARD_XML_NAMESPACES.has(attrs.get(a) ?? "")
  ) {
    return false;
  }
  if (a === "href") {
    if (t === "a" || t === "area" || t === "base") return false;
    if (t === "link") {
      const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      return rels.length === 0 || rels.some((r) => !NON_LOADING_LINK_RELS.has(r));
    }
    return true; // SVG <image href>, <use href>, …
  }
  if (a === "action" || a === "formaction") return false; // submits on click only
  if (LOADING_ATTRS.has(a)) return true;
  return hasJs;
}

/** Every string stored under `key`, at any depth (field defaults, content values, list items). */
function stringsUnder(value: unknown, key: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) stringsUnder(v, key, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (k === key) collectStrings(v, out);
    stringsUnder(v, key, out);
  }
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out);
}

/**
 * Every external host a module makes the visitor's browser contact when
 * the page loads — judged on the markup it ships, with each `{{field}}`
 * resolved to the values it renders with (field defaults, placement
 * content values, list items). Links do not count: `<a href>` contacts
 * nobody until clicked. The module's own JavaScript is still read
 * over-inclusively, since a URL there may be loaded at any time.
 *
 * The background scan and the render-time gate both call this, so the
 * two can never disagree about what a module reaches.
 */
export function moduleHosts(module: {
  html: string;
  css: string;
  js: string;
  fields?: unknown;
  contentValues: ReadonlyArray<unknown>;
}): string[] {
  const hasJs = module.js.trim().length > 0;
  const fieldDefaults = Array.isArray(module.fields)
    ? module.fields.map((f) => {
        const field = f as { name?: unknown; default?: unknown };
        return typeof field.name === "string" ? { [field.name]: field.default } : {};
      })
    : [];
  const sources = [...fieldDefaults, ...module.contentValues];
  const urls: string[] = [];
  const addValue = (raw: string): void => {
    let resolved = false;
    for (const m of raw.matchAll(PLACEHOLDER_RE)) {
      resolved = true;
      const name = (m[1] ?? "").split(".").at(-1) ?? "";
      for (const src of sources) stringsUnder(src, name, urls);
    }
    if (!resolved || raw.replace(PLACEHOLDER_RE, "").trim().length > 0) urls.push(raw);
  };

  for (const tag of module.html.matchAll(TAG_RE)) {
    const tagName = tag[1] ?? "";
    const attrs = new Map<string, string>();
    for (const a of (tag[2] ?? "").matchAll(ATTR_RE)) {
      attrs.set((a[1] ?? "").toLowerCase(), a[2] ?? a[3] ?? "");
    }
    for (const [name, value] of attrs) {
      if (name === "style") {
        for (const u of value.matchAll(CSS_URL_RE)) addValue(u[1] ?? "");
        continue;
      }
      if (!attrLoads(tagName, name, attrs, hasJs)) continue;
      if (name === "srcset" || name === "data-srcset") {
        for (const candidate of value.split(",")) addValue(candidate.trim().split(/\s+/)[0] ?? "");
      } else {
        addValue(value);
      }
    }
  }
  for (const u of module.css.matchAll(CSS_URL_RE)) addValue(u[1] ?? "");

  const found = new Set<string>();
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0 || isFirstParty(trimmed)) continue;
    const host = hostOf(trimmed);
    if (host) found.add(host);
  }
  for (const host of externalHosts({ js: module.js })) found.add(host);
  return [...found].sort();
}

/** A stored verdict about one module, as far as the gate needs it. */
export interface GuardVerdict {
  readonly detected_hosts: ReadonlyArray<string>;
  readonly status: "pending" | "gated" | "allowed";
  readonly category_key: string;
}

/**
 * Whether the render-time gate withholds a module, and under which
 * consent category — or `null` to render it.
 *
 * Fails closed: a stored verdict counts only when it was made about
 * exactly the hosts the module reaches NOW. A module edited since the
 * last scan, or created on a chat branch the scan never sees, is judged
 * from its hosts alone — withheld under the vendor's known category, or
 * as `unclassified` until the operator rules on it.
 *
 * @param hosts `moduleHosts()` of the content about to render
 * @param guard the stored verdict for the module, if any
 * @param classify maps hosts to a consent category, `null` if unknown
 */
export function deferralReason(
  hosts: ReadonlyArray<string>,
  guard: GuardVerdict | undefined,
  classify: (hosts: ReadonlyArray<string>) => string | null,
): string | null {
  if (hosts.length === 0) return null;
  if (guard && JSON.stringify(guard.detected_hosts) === JSON.stringify(hosts)) {
    if (guard.status === "allowed") return null;
    return guard.status === "gated" ? guard.category_key : "unclassified";
  }
  return classify(hosts) ?? "unclassified";
}

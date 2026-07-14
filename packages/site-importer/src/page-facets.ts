// SPDX-License-Identifier: MPL-2.0

/**
 * issue #278 — pure per-facet extractors for the homepage-driven
 * migration discovery flow.
 *
 * The redesigned migration flow (issue #278) inspects a site's homepage
 * cheaply to understand its structure, then samples one page per type.
 * `inspect_external_page` pulls ONLY the facets a given step needs so a
 * discovery turn stays tiny (links + meta) while a template-building
 * turn goes rich (markup + screenshot + tokens). These are the pure,
 * HTML-in → structured-data-out halves of three of those facets:
 *
 *   - {@link extractOutboundLinks} — links with anchor text, rel, and
 *     nav|footer|body location, resolved relative→absolute.
 *   - {@link extractAltTexts} — the img alt / aria-label inventory.
 *   - {@link extractPageMeta} — title, description, canonical, lang,
 *     hreflang alternates, and an h1–h3 outline.
 *
 * Every scan is linear (indexOf / bounded char-class regex) per the
 * #113 ReDoS discipline — the input is an untrusted third-party page.
 */

/** Where an outbound link sits in the document's structure. */
export type LinkLocation = "nav" | "footer" | "body";

/** One resolved outbound link with the signals the page-type classifier
 *  and the AI need to reason about site structure. */
export interface OutboundLink {
  /** Absolute URL (relative hrefs resolved against the page URL). */
  readonly href: string;
  /** Visible anchor text, tags stripped + whitespace-collapsed, capped. */
  readonly text: string;
  /** `rel` attribute value verbatim, or "" when absent. */
  readonly rel: string;
  readonly location: LinkLocation;
}

/** One image/aria alt-text inventory entry. */
export interface AltTextEntry {
  /** "img-alt" for `<img alt>`, else the aria-label carrier. */
  readonly kind: "img-alt" | "aria-label";
  /** The alt/aria-label text, or "" for a present-but-empty img alt
   *  (decorative-image signal — kept, not dropped). */
  readonly text: string;
  /** Absolute src for img entries, when resolvable. */
  readonly src?: string;
}

/** A `<link rel="alternate" hreflang>` translation pointer. */
export interface HreflangAlternate {
  readonly hreflang: string;
  readonly href: string;
}

/** Structured page metadata — the `meta` facet's payload. */
export interface PageMeta {
  readonly title: string;
  readonly metaDescription: string;
  /** Absolute canonical URL, or "" when the page declares none. */
  readonly canonical: string;
  /** `<html lang>` value, or "" when absent. */
  readonly lang: string;
  readonly hreflangAlternates: readonly HreflangAlternate[];
  /** h1–h3 outline as `h{n}: text` lines, in document order. */
  readonly headings: readonly string[];
}

const MAX_LINKS = 300;
const MAX_ALT_ENTRIES = 200;
const MAX_HEADINGS = 40;
const MAX_HREFLANG = 60;
const ANCHOR_TEXT_CAP = 120;

const REL_RE = /\brel\s*=\s*["']([^"']*)["']/i;
const HREF_RE = /\bhref\s*=\s*["']([^"']*)["']/i;
/** Matches `rel="canonical"` anywhere in a captured `<link>` attr span. */
const REL_CANONICAL_RE = /\brel\s*=\s*["']canonical["']/i;

/** Resolve `href` against `baseUrl`, dropping non-navigational schemes.
 *  Returns null for fragments, mailto:/tel:/javascript:/data:, and
 *  unparseable values — callers skip those. */
function resolveHref(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    /^(mailto:|tel:|javascript:|data:)/i.test(trimmed)
  ) {
    return null;
  }
  try {
    const u = new URL(trimmed, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Collect [start, end) byte ranges of every `<tag>…</tag>` block,
 *  depth-aware so nested same-name tags don't split a range. Linear. */
function collectTagRanges(html: string, tag: string): Array<readonly [number, number]> {
  const lower = html.toLowerCase();
  const ranges: Array<readonly [number, number]> = [];
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;
  const terminates = (ch: string | undefined): boolean =>
    ch === ">" || ch === " " || ch === "\t" || ch === "\n" || ch === "/";
  let from = 0;
  while (ranges.length < 50) {
    const open = lower.indexOf(openNeedle, from);
    if (open === -1) break;
    if (!terminates(lower[open + openNeedle.length])) {
      from = open + openNeedle.length;
      continue;
    }
    let depth = 1;
    let cursor = lower.indexOf(">", open);
    if (cursor === -1) break;
    cursor += 1;
    while (depth > 0) {
      const nextOpen = lower.indexOf(openNeedle, cursor);
      const nextClose = lower.indexOf(closeNeedle, cursor);
      if (nextClose === -1) {
        cursor = html.length; // unclosed — rest of the doc is the block
        break;
      }
      if (
        nextOpen !== -1 &&
        nextOpen < nextClose &&
        terminates(lower[nextOpen + openNeedle.length])
      ) {
        depth += 1;
        cursor = nextOpen + openNeedle.length;
      } else {
        depth -= 1;
        cursor = nextClose + closeNeedle.length;
      }
    }
    ranges.push([open, cursor] as const);
    from = cursor;
  }
  return ranges;
}

function locationOf(
  offset: number,
  navRanges: ReadonlyArray<readonly [number, number]>,
  footerRanges: ReadonlyArray<readonly [number, number]>,
): LinkLocation {
  for (const [s, e] of navRanges) if (offset >= s && offset < e) return "nav";
  for (const [s, e] of footerRanges) if (offset >= s && offset < e) return "footer";
  return "body";
}

/**
 * Yield the raw attribute span of every `<tag …>` open tag, in document
 * order. The attribute run is `[^<>]*` (tempered), NOT `[^>]*`: a valid
 * open tag never contains a literal `<`, so real HTML matches identically,
 * but a `<meta<meta…` / `<link<link…` stream now fails each unanchored
 * retry in O(1) instead of driving the O(n²) backtracking CodeQL flags as
 * js/polynomial-redos. Same tempered-dot hardening `extractor.ts` adopted
 * for #113; this brings the #278 migration facets to the same discipline.
 * Callers pull individual attributes off the span with the single-attr
 * regexes (each anchored by a required literal, so linear on the span).
 *
 * @param tagPattern a trusted, internal tag matcher spliced verbatim into
 *   the source — either a literal name (`"meta"`) or a char-class opener
 *   (`"[a-z][a-z0-9-]*"` for "any element"). Never attacker-controlled.
 */
function* eachOpenTagAttrs(html: string, tagPattern: string): Generator<string> {
  const re = new RegExp(`<${tagPattern}\\b([^<>]*)>`, "gi");
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    yield m[1] ?? "";
  }
}

/** Strip tags from an anchor's inner HTML → collapsed visible text.
 *  The tag matcher is `<[^<>]*>` (tempered), not `<[^>]*>`: a valid tag
 *  never contains a literal `<`, so real markup is stripped identically,
 *  but a `<<<<…` run now fails each unanchored retry in O(1) rather than
 *  driving the O(n²) backtracking CodeQL flags as js/polynomial-redos. */
function anchorText(innerHtml: string): string {
  return innerHtml
    .replace(/<[^<>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ANCHOR_TEXT_CAP);
}

/**
 * Extract outbound links with anchor text, rel, and structural
 * location. `location` is computed from the link's byte offset relative
 * to the page's `<nav>`/`<footer>` block ranges, so a link inside a
 * header's nav reads as "nav" and a legal link in the footer reads as
 * "footer" — the signals the page-type classifier weights.
 *
 * @param baseUrl the page's own (post-redirect) URL — relative hrefs
 *   resolve against it, so every returned href is absolute.
 */
export function extractOutboundLinks(html: string, baseUrl: string): OutboundLink[] {
  const navRanges = collectTagRanges(html, "nav");
  const footerRanges = collectTagRanges(html, "footer");
  const out: OutboundLink[] = [];
  const seen = new Set<string>();
  // Each anchor open-tag + inner text up to </a>. Both the attribute run
  // (`[^<>]*`, tempered) and the body (the unrolled `(?:[^<]|<(?!\/a>))*`
  // form, each char consumed once) stay linear, so a "<a<a…" stream can't
  // drive the O(n²) backtracking CodeQL flags as js/polynomial-redos (#113).
  const anchorRe = /<a\b([^<>]*)>((?:[^<]|<(?!\/a>))*)<\/a>/gi;
  for (let m = anchorRe.exec(html); m !== null && out.length < MAX_LINKS; m = anchorRe.exec(html)) {
    const attrs = m[1] ?? "";
    const hrefRaw = HREF_RE.exec(attrs)?.[1];
    if (!hrefRaw) continue;
    const href = resolveHref(hrefRaw, baseUrl);
    if (!href) continue;
    const location = locationOf(m.index, navRanges, footerRanges);
    const key = `${location} ${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      href,
      text: anchorText(m[2] ?? ""),
      rel: REL_RE.exec(attrs)?.[1]?.trim() ?? "",
      location,
    });
  }
  return out;
}

const ALT_RE = /\balt\s*=\s*["']([^"']*)["']/i;
const SRC_RE = /\bsrc\s*=\s*["']([^"']*)["']/i;
/** Extracts an `aria-label` value (1–300 chars) from a captured attr span. */
const ARIA_LABEL_ATTR_RE = /\baria-label\s*=\s*["']([^"']{1,300})["']/i;

// Single-attribute extractors for extractPageMeta. Each runs against a
// captured `<meta>` / `<html>` / `<link>` attr span (not the whole doc),
// anchored by a required literal, so it stays linear on the span.
const META_NAME_DESC_RE = /\bname\s*=\s*["']description["']/i;
const META_CONTENT_RE = /\bcontent\s*=\s*["']([^"']{0,500})["']/i;
const LANG_ATTR_RE = /\blang\s*=\s*["']([^"']{0,35})["']/i;
const HREFLANG_ATTR_RE = /\bhreflang\s*=\s*["']([^"']{0,35})["']/i;

/**
 * Inventory the page's accessible-text signals: every `<img>`'s alt
 * (present-but-empty alts are kept — a decorative-image signal) plus
 * every element carrying an `aria-label`. Migration reuses these as
 * seed alt text so the rebuilt site doesn't regress on accessibility.
 */
export function extractAltTexts(html: string, baseUrl: string): AltTextEntry[] {
  const out: AltTextEntry[] = [];
  for (const attrs of eachOpenTagAttrs(html, "img")) {
    if (out.length >= MAX_ALT_ENTRIES) break;
    const altMatch = ALT_RE.exec(attrs);
    if (!altMatch) continue;
    const srcRaw = SRC_RE.exec(attrs)?.[1];
    const src = srcRaw ? (resolveHref(srcRaw, baseUrl) ?? undefined) : undefined;
    out.push({ kind: "img-alt", text: altMatch[1] ?? "", ...(src ? { src } : {}) });
  }
  // Any element can carry aria-label — scan every open tag, keep the ones
  // that do. (Replaces the former single regex whose two `[^>]*` runs around
  // the aria-label literal were the js/polynomial-redos shape.)
  for (const attrs of eachOpenTagAttrs(html, "[a-z][a-z0-9-]*")) {
    if (out.length >= MAX_ALT_ENTRIES) break;
    const text = ARIA_LABEL_ATTR_RE.exec(attrs)?.[1]?.trim();
    if (text) out.push({ kind: "aria-label", text });
  }
  return out;
}

/**
 * Extract structured page metadata: title, meta description, canonical
 * URL, `<html lang>`, hreflang translation alternates, and an h1–h3
 * outline. Canonical + hreflang hrefs are resolved absolute against
 * `baseUrl`. This is the cheap "what is this page and how does it relate
 * to its translations" signal the discovery step leans on.
 */
export function extractPageMeta(html: string, baseUrl: string): PageMeta {
  const title = /<title[^<>]*>([^<]{0,300})/i.exec(html)?.[1]?.trim() ?? "";

  // Meta description: pull `content` from the first <meta> carrying
  // name="description". Splitting the former single two-`[^>]*`-run regex
  // (CodeQL js/polynomial-redos, "many repetitions of name=\"description\"")
  // into a per-tag attr scan + fixed sub-matches removes the ambiguous
  // overlap. A name=description meta without a usable content keeps scanning,
  // matching the old `.exec` that skipped ahead to the next full match.
  let metaDescription = "";
  for (const attrs of eachOpenTagAttrs(html, "meta")) {
    if (!META_NAME_DESC_RE.test(attrs)) continue;
    const content = META_CONTENT_RE.exec(attrs)?.[1];
    if (content !== undefined) {
      metaDescription = content;
      break;
    }
  }

  let lang = "";
  for (const attrs of eachOpenTagAttrs(html, "html")) {
    lang = LANG_ATTR_RE.exec(attrs)?.[1]?.trim() ?? "";
    break; // the document's first <html> is authoritative
  }

  // Canonical: the two former alternative regexes (rel-before-href and
  // href-before-rel, each with several `[^>]*` runs) collapse to one <link>
  // attr scan that is order-independent by construction and linear.
  let canonical = "";
  for (const attrs of eachOpenTagAttrs(html, "link")) {
    if (!REL_CANONICAL_RE.test(attrs)) continue;
    const href = HREF_RE.exec(attrs)?.[1];
    if (href) canonical = resolveHref(href, baseUrl) ?? "";
    break;
  }

  const hreflangAlternates: HreflangAlternate[] = [];
  for (const attrs of eachOpenTagAttrs(html, "link")) {
    if (hreflangAlternates.length >= MAX_HREFLANG) break;
    const hreflang = HREFLANG_ATTR_RE.exec(attrs)?.[1]?.trim();
    const hrefRaw = HREF_RE.exec(attrs)?.[1];
    const href = hrefRaw ? resolveHref(hrefRaw, baseUrl) : null;
    if (hreflang && href) hreflangAlternates.push({ hreflang, href });
  }

  const headings: string[] = [];
  const headingRe = /<h([1-3])\b[^<>]*>([^<]{0,200})/gi;
  for (
    let h = headingRe.exec(html);
    h !== null && headings.length < MAX_HEADINGS;
    h = headingRe.exec(html)
  ) {
    const text = h[2]?.trim();
    if (text) headings.push(`h${h[1]}: ${text}`);
  }

  return { title, metaDescription, canonical, lang, hreflangAlternates, headings };
}

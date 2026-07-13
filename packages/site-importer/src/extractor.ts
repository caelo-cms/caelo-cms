// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — per-page extraction. Given fetched HTML, split into:
 *   - title (from <title>)
 *   - modules: header / 1..N body sections / footer
 *   - themeTokens: a small set of CSS custom properties + computed
 *     fonts/colors sampled from `:root` declarations in inline
 *     <style> blocks (best-effort — we don't run a full CSS engine)
 *
 * Heuristic + best-effort. Owner reviews + edits in /security/import.
 */

import { Parser } from "htmlparser2";

export interface ExtractedModule {
  readonly blockName: "header" | "content" | "footer";
  readonly position: number;
  readonly html: string;
  readonly displayName: string;
}

export interface ExtractedPage {
  readonly title: string;
  readonly modules: ReadonlyArray<ExtractedModule>;
  readonly themeTokens: Readonly<Record<string, string>>;
}

/**
 * Result of {@link extractModulesFromHtml}. Carries the extracted
 * modules PLUS loud counters for everything the extractor removed —
 * run #10 D3: silent stripping is not allowed (CLAUDE.md §2), the
 * caller persists `commentsStripped` as a visible per-page note.
 */
export interface ModuleExtraction {
  readonly modules: ReadonlyArray<ExtractedModule>;
  /** Number of comment-thread subtrees removed by {@link stripCommentThreads}. */
  readonly commentsStripped: number;
}

export function extractTitle(html: string): string {
  // Linear on uncontrolled input (js/polynomial-redos): the opening uses
  // `[^<>]*` (tag attributes can't contain `<`), so a stream of `<title<title…`
  // can't drive O(n²) unanchored retries of the open tag; the body is the
  // unrolled-loop form `(?:[^<]|<(?!\/title>))*`, each char consumed once.
  const m = html.match(/<title[^<>]*>((?:[^<]|<(?!\/title>))*)<\/title>/i);
  if (!m) return "";
  return decodeEntities(m[1]?.trim() ?? "").slice(0, 200);
}

/**
 * Split a page into header / sections / footer modules.
 *
 * Strategy:
 *   1. Find <header>...</header> in the document body. If present →
 *      one header module.
 *   2. Find <footer>...</footer>. If present → one footer module.
 *   3. Body content between header + footer is split into modules at
 *      each top-level <section>, <article>, or <main> element. If no
 *      semantic markers exist → one big "content" module.
 *
 * Returns positions in render order so `page_modules` rows insert
 * cleanly when the Owner accepts. The result also carries the loud
 * `commentsStripped` counter (run #10 D3) so callers surface what was
 * removed instead of dropping it silently.
 */
export function extractModulesFromHtml(html: string): ModuleExtraction {
  const withoutComments = stripCommentThreads(sliceBody(html));
  const body = stripConsentNoise(withoutComments.html);
  const modules: ExtractedModule[] = [];

  const header = sliceTagBlock(body, "header");
  if (header) {
    modules.push({
      blockName: "header",
      position: 0,
      html: header.html,
      displayName: "Header (imported)",
    });
  }

  const footer = sliceTagBlock(body, "footer");
  if (footer) {
    modules.push({
      blockName: "footer",
      position: 0,
      html: footer.html,
      displayName: "Footer (imported)",
    });
  }

  // Strip header + footer from the body before splitting content.
  let middle = body;
  if (header) middle = middle.replace(header.html, "");
  if (footer) middle = middle.replace(footer.html, "");

  // Pull each top-level <section> / <article> / <main> out as its
  // own module. If none, the whole middle becomes one content module.
  const sectionMatches = collectTopLevelTags(middle, ["section", "article", "main"]);
  if (sectionMatches.length > 0) {
    sectionMatches.forEach((m, i) => {
      modules.push({
        blockName: "content",
        position: i,
        html: m,
        displayName: `Section ${i + 1} (imported)`,
      });
    });
  } else {
    const trimmed = middle.trim();
    if (trimmed.length > 0) {
      modules.push({
        blockName: "content",
        position: 0,
        html: trimmed,
        displayName: "Body (imported)",
      });
    }
  }

  return { modules, commentsStripped: withoutComments.removed };
}

/**
 * Sample theme tokens from inline <style> blocks. Looks for
 * :root { --name: value; ... } declarations. Cheap; doesn't run a
 * full CSS parser. The Owner refines tokens via /security/structured.
 */
export function extractThemeTokens(html: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  // The patterns below replace a lazy `[\s\S]*?` (or an ambiguous
  // `([^;]+?)\s*$`) that backtracks O(n²) on unclosed/large input
  // (CodeQL js/polynomial-redos):
  //   - `<style>…</style>` is linear: the opening `[^<>]*` (attributes can't
  //     contain `<`) blocks O(n²) unanchored retries on a `<style<style…`
  //     stream, and the body is the unrolled-loop form `(?:[^<]|<(?!CLOSE))*`
  //     (each char consumed once). `:root { … }` keeps the single-char
  //     tempered-dot (CodeQL accepts a single-char delimiter).
  //   - the per-declaration parse captures the value greedily to end-of-line
  //     (`([\s\S]*)$`, one path) and trims in code, avoiding the
  //     `([^;]+?)\s*$` overlap between the lazy body and the trailing `\s*`.
  const styleBlocks = [...html.matchAll(/<style[^<>]*>((?:[^<]|<(?!\/style>))*)<\/style>/gi)];
  for (const block of styleBlocks) {
    const css = block[1] ?? "";
    const root = css.match(/:root\s*\{((?:(?!\})[\s\S])*)\}/);
    if (!root) continue;
    const decls = root[1] ?? "";
    for (const line of decls.split(";")) {
      const m = line.match(/^\s*(--[a-zA-Z0-9-]+)\s*:([\s\S]*)$/);
      const value = m?.[2]?.trim();
      if (m?.[1] && value) {
        tokens[m[1]] = value;
      }
    }
  }
  return tokens;
}

// ---- helpers ----------------------------------------------------------------

/**
 * Strip cookie-consent / GDPR-banner subtrees from crawled body HTML.
 *
 * Live-hit (searchviu migration, 2026-07-12): the source site's
 * Complianz "Manage Consent" modal was extracted as page CONTENT and
 * rendered mid-page in every composed draft. Consent chrome is
 * plugin-injected noise, never operator content. Heuristic: drop any
 * element whose id/class matches the known consent-plugin fingerprints
 * or the generic cookie/consent tokens; matching is attribute-scoped,
 * so body text ABOUT cookies is untouched.
 */
const CONSENT_NOISE_PATTERN =
  /(cmplz|cookiebot|onetrust|borlabs|usercentrics|didomi|klaro|iubenda|cookie-?(banner|notice|consent|law|bar)|consent-?(banner|modal|manager|popup)|gdpr-?(banner|popup))/i;

export function stripConsentNoise(html: string): string {
  return stripMatchingSubtrees(html, (attrs) => {
    const fingerprint = `${attrs.id ?? ""} ${attrs.class ?? ""} ${attrs["data-nosnippet"] ?? ""}`;
    return CONSENT_NOISE_PATTERN.test(fingerprint);
  }).html;
}

/**
 * Strip comment-thread subtrees from crawled body HTML.
 *
 * Live-hit (searchviu migration run #10, D3): imported blog bodies
 * carried the source's full WordPress comment threads — 90+ comments
 * per post — which bloated the composed pages and blew the rebuild
 * subagents' context windows. Comment threads are visitor-generated
 * discussion chrome, never operator content; Caelo's comment story is
 * a plugin, not imported markup.
 *
 * Matching is attribute-scoped like {@link stripConsentNoise}: ids and
 * class TOKENS are compared against the known WordPress / page-builder
 * comment fingerprints (`#comments`, `ol.commentlist`, `.comment-list`,
 * `#respond`, `.comment-respond`, Elementor/Divi/Avada widgets), so
 * body prose that merely mentions comments is untouched.
 *
 * @returns the stripped HTML plus the number of removed subtrees —
 *   callers MUST surface the count (e.g. a `comments-stripped:<n>`
 *   note); silent removal violates CLAUDE.md §2.
 */
export function stripCommentThreads(html: string): { html: string; removed: number } {
  return stripMatchingSubtrees(html, (attrs) => {
    const id = (attrs.id ?? "").toLowerCase();
    if (COMMENT_THREAD_ID_PATTERN.test(id)) return true;
    for (const token of (attrs.class ?? "").toLowerCase().split(/\s+/)) {
      if (token !== "" && COMMENT_THREAD_CLASS_PATTERN.test(token)) return true;
    }
    return false;
  });
}

// Ids are matched EXACTLY (WP core: #comments, #respond, #commentform;
// Disqus: #disqus_thread) — substring matching on ids like
// `intercom-comments-frame` would overreach.
const COMMENT_THREAD_ID_PATTERN = /^(comments|respond|commentform|disqus_thread|reply-title)$/;
// Class TOKENS (whole class-list entries, not substrings): WP core +
// theme conventions (`comment-list`, `commentlist`, `comments-area`,
// `comment-respond`, `comments-title`, `.comments-link` post-meta
// links), block editor (`wp-block-comments*`, `wp-block-post-comments*`),
// and the big page builders (Elementor `elementor-widget-post-comments`,
// Divi `et_pb_comments*`, Avada `fusion-comments*`). The bare `comments`
// token catches `<section class="comments">` wrappers. Deliberately NOT
// matched: the bare `comment` token — prose/testimonial markup uses it
// too freely, and WP's `li.comment` items always sit inside a matched
// list ancestor anyway.
const COMMENT_THREAD_CLASS_PATTERN =
  /^(comments|commentlist|comment-list|comments-area|comments-title|comments-link|comment-respond|comment-form|comment-reply-title|comments-wrap(per)?|post-comments|wp-block-(post-)?comments(-[a-z-]+)?|elementor-widget-post-comments|et_pb_comments(_[a-z0-9_]+)?|fusion-comments(-[a-z-]+)?)$/;

/**
 * Shared subtree-removal walker for the extraction strippers. Walks
 * `html` with htmlparser2 and removes every element (with its whole
 * subtree) whose attributes satisfy `matches`. Byte-range based so the
 * surviving markup is untouched (no re-serialisation drift).
 */
function stripMatchingSubtrees(
  html: string,
  matches: (attrs: Record<string, string>) => boolean,
): { html: string; removed: number } {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let skipDepth = -1;
  let start = -1;
  const parser = new Parser({
    onopentag(_name, attrs) {
      depth += 1;
      if (skipDepth === -1 && matches(attrs)) {
        skipDepth = depth;
        start = parser.startIndex;
      }
    },
    onclosetag() {
      if (skipDepth === depth && start >= 0) {
        ranges.push([start, parser.endIndex + 1]);
        skipDepth = -1;
        start = -1;
      }
      depth -= 1;
    },
  });
  parser.write(html);
  parser.end();
  if (ranges.length === 0) return { html, removed: 0 };
  let out = html;
  for (const [from, to] of ranges.reverse()) {
    out = out.slice(0, from) + out.slice(to);
  }
  return { html: out, removed: ranges.length };
}

function sliceBody(html: string): string {
  // Linear replacement for the greedy `([\s\S]*)<\/body>` CodeQL flagged as
  // polynomial: opening `[^<>]*` blocks O(n²) retries on a `<body<body…`
  // stream, body is the unrolled-loop form. A well-formed document has a
  // single `</body>`, so first-match equals the greedy last-match here.
  const m = html.match(/<body[^<>]*>((?:[^<]|<(?!\/body>))*)<\/body>/i);
  return m ? (m[1] ?? "") : html;
}

interface TagBlock {
  html: string;
}

/** Slice the FIRST occurrence of `<tag>…</tag>` (at any depth). */
function sliceTagBlock(html: string, tag: string): TagBlock | null {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "i");
  const close = new RegExp(`</${tag}>`, "i");
  const o = open.exec(html);
  if (!o) return null;
  const c = close.exec(html.slice(o.index));
  if (!c) return null;
  const end = o.index + c.index + c[0].length;
  return { html: html.slice(o.index, end) };
}

/**
 * Walk html via htmlparser2; collect every TOP-LEVEL element matching
 * one of the requested tag names (depth=0 children of the body). Avoids
 * double-counting nested sections.
 */
function collectTopLevelTags(html: string, tagNames: string[]): string[] {
  const wanted = new Set(tagNames.map((t) => t.toLowerCase()));
  const collected: string[] = [];
  let depth = 0;
  let captureStart = -1;
  let captureName = "";
  let cursor = 0;
  // The parser doesn't give byte offsets directly in htmlparser2; we
  // approximate by re-scanning and accumulating a manual cursor in a
  // simple stream.
  const parser = new Parser({
    onopentag(name) {
      const lower = name.toLowerCase();
      if (depth === 0 && wanted.has(lower)) {
        captureStart = cursor;
        captureName = lower;
      }
      depth += 1;
    },
    onclosetag(name) {
      depth -= 1;
      if (depth === 0 && captureStart >= 0 && name.toLowerCase() === captureName) {
        // Re-derive the actual slice via regex from captureStart.
        const slice = sliceFromOpenAt(html, captureStart, captureName);
        if (slice) collected.push(slice);
        captureStart = -1;
        captureName = "";
      }
    },
    ontext(t) {
      cursor += t.length;
    },
  });
  parser.write(html);
  parser.end();
  return collected;
}

function sliceFromOpenAt(html: string, _hint: number, tag: string): string | null {
  // Simple search-and-balance from the first `<tag` after _hint chars.
  const re = new RegExp(`<${tag}\\b[^>]*>`, "ig");
  const m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    // Balance until matching close.
    let i = m.index + m[0].length;
    let stack = 1;
    const openRe = new RegExp(`<${tag}\\b`, "ig");
    const closeRe = new RegExp(`</${tag}>`, "ig");
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    while (stack > 0) {
      const o = openRe.exec(html);
      const c = closeRe.exec(html);
      if (!c) return null;
      if (o && o.index < c.index) {
        stack += 1;
        openRe.lastIndex = o.index + 1;
        closeRe.lastIndex = o.index + 1;
      } else {
        stack -= 1;
        i = c.index + c[0].length;
        openRe.lastIndex = i;
        closeRe.lastIndex = i;
      }
    }
    return html.slice(m.index, i);
  }
  return null;
}

function decodeEntities(s: string): string {
  // `&amp;` is decoded LAST. Decoding it first would turn an encoded
  // `&amp;lt;` (the literal text "&lt;") into a live "<" via the next
  // replace — a double-unescape (CodeQL js/double-escaping). Decoding the
  // other entities first, then `&amp;`, yields the correct single-level
  // decode: `&amp;lt;` → `&lt;`, while `&lt;` → `<`.
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * issue #195 — every <style> block's contents, concatenated. The
 * pre-#195 pipeline kept only :root custom properties and THREW AWAY
 * the stylesheet, which is why imported pages rendered unstyled
 * ("design behalten" without the design). Linear scan, 512KB cap.
 */
export function extractPageCss(html: string): string {
  const parts: string[] = [];
  const lower = html.toLowerCase();
  let from = 0;
  let total = 0;
  while (total < 512 * 1024) {
    const open = lower.indexOf("<style", from);
    if (open === -1) break;
    const openEnd = lower.indexOf(">", open);
    if (openEnd === -1) break;
    const close = lower.indexOf("</style", openEnd);
    if (close === -1) break;
    const chunk = html.slice(openEnd + 1, close);
    parts.push(chunk);
    total += chunk.length;
    from = close + 8;
  }
  return parts.join("\n");
}

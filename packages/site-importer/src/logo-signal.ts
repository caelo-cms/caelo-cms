// SPDX-License-Identifier: MPL-2.0

/**
 * Logo-preservation guardrail for site migration.
 *
 * The migration flow must IMPORT the operator's real logo, never redraw
 * it as an HTML/CSS text wordmark. The skill body already forbids this
 * (migrations 0151 + 0154), but prose alone let a live run
 * (searchviu.com) ship a hand-authored `<a class="sv-header__logo">
 * search<span>VIU</span></a>` wordmark while the source header carried a
 * real `<img src="…searchviu-logo2x.png">` — media_assets=0 for the run.
 * This module is the STRUCTURAL backstop the `imports.migrate_media` op
 * uses to catch that redraw and record it LOUDLY in the run's
 * error/warning ledger (CLAUDE.md §2 no silent fallbacks, §4 root-cause).
 *
 * Two pure detectors:
 *  - {@link sourceHeaderHasLogoImage} — did the crawled homepage header
 *    carry a real logo `<img>` / inline `<svg>`? (the asset that SHOULD
 *    have been preserved.)
 *  - {@link rebuiltHeaderHasLogoRef} — does the rebuilt chrome header
 *    reference a real logo: an `<img>` at Caelo media (`/_caelo/…`) or a
 *    `{{theme_logo_url}}` / `{{theme_logo_dark_url}}` placeholder? A bound
 *    theme logo asset is an independent third signal the caller checks
 *    from the DB and ORs in.
 *
 * When the source had a logo image and the rebuild has none of those, the
 * header logo was almost certainly hand-authored as text/CSS — a
 * migration defect. Conservative by construction: it only fires when a
 * source logo image is positively detected, so a site whose brand really
 * is a styled-text wordmark (no source image) is never flagged.
 *
 * Linear scans only (#113 ReDoS discipline) — the source HTML is
 * untrusted third-party markup, so every regex is a bounded, tempered
 * char class with no ambiguous overlap.
 */

/** One crawler-extracted source block: `{blockName, html}`. */
export interface ProposedModuleBlock {
  readonly blockName?: string | null;
  readonly html?: string | null;
}

/** Result of the source-logo scan. */
export interface SourceLogoSignal {
  /** True when the homepage header carried a real logo image/svg. */
  readonly hasLogo: boolean;
  /** Short human-readable evidence (matched src / tag) for the ledger. */
  readonly evidence?: string;
}

/** `class`/`id`/`alt`/`src` tokens that mark an image as the brand logo. */
const LOGO_TOKEN_RE = /\b(?:logo|wordmark|brand(?:mark|ing)?|site-?icon)\b/i;
/** A block whose name suggests it is the site header / masthead / nav. */
const HEADER_BLOCK_RE = /\b(?:header|masthead|topbar|navbar|nav|brand)\b/i;
const SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']*)["']/i;

/** Cap on how much markup we scan per block — headers are small; this
 *  bounds work on a pathological giant block without changing outcomes. */
const MAX_SCAN_CHARS = 200_000;

/**
 * Does an `<img …>` open-tag span look like a brand logo? True when any
 * of its `src` / `class` / `id` / `alt` carries a logo token. The span is
 * the attribute run of a single `<img>` (no `<`), so the test is linear.
 */
function imgAttrsLookLikeLogo(imgAttrs: string): string | null {
  if (LOGO_TOKEN_RE.test(imgAttrs)) {
    const src = SRC_ATTR_RE.exec(imgAttrs)?.[1];
    return src ? `img src=${src.slice(0, 160)}` : "img (logo class/alt)";
  }
  return null;
}

/**
 * Scan a single block's HTML for a header logo image. Returns evidence
 * text when the block contains EITHER a logo-tokened `<img>` anywhere OR,
 * when `isHeader` is true, any `<img>` / inline `<svg>` at all (the
 * canonical header image is the logo). Linear: one tempered `<img …>`
 * open-tag regex, plus a literal `<svg` indexOf.
 */
function scanBlockForLogo(html: string, isHeader: boolean): string | null {
  const slice = html.length > MAX_SCAN_CHARS ? html.slice(0, MAX_SCAN_CHARS) : html;
  // Tempered attribute run `[^<>]*` — a valid <img> never contains `<`,
  // so real markup matches identically while a "<img<img…" stream fails
  // each retry in O(1) (js/polynomial-redos discipline, cf. page-facets).
  const imgRe = /<img\b([^<>]*)>/gi;
  let firstImg: string | null = null;
  for (let m = imgRe.exec(slice); m !== null; m = imgRe.exec(slice)) {
    const attrs = m[1] ?? "";
    const logo = imgAttrsLookLikeLogo(attrs);
    if (logo) return logo;
    if (firstImg === null) {
      const src = SRC_ATTR_RE.exec(attrs)?.[1];
      firstImg = src ? `img src=${src.slice(0, 160)}` : "img";
    }
  }
  if (isHeader) {
    if (firstImg) return firstImg;
    if (/<svg\b/i.test(slice)) return "inline svg";
  }
  return null;
}

/**
 * Detect whether the crawled homepage header carried a real logo asset.
 *
 * Strategy, conservative on purpose:
 *  1. In any block whose name looks like a header/nav/masthead, OR the
 *     FIRST block (headers are extracted first), treat any `<img>` /
 *     inline `<svg>` as the logo.
 *  2. Anywhere in any block, a logo-tokened `<img>` (src/class/id/alt
 *     matching logo|brand|wordmark) counts — catches WordPress
 *     `custom-logo`, themes that don't wrap the header in a named block.
 *
 * Only positive image evidence returns `hasLogo: true`; a site whose
 * brand is genuinely styled text (no image) yields `false` and is never
 * flagged as a redraw.
 *
 * @param blocks the homepage import_page's `proposed_modules` array.
 */
export function sourceHeaderHasLogoImage(blocks: readonly ProposedModuleBlock[]): SourceLogoSignal {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const html = block?.html ?? "";
    if (html === "") continue;
    const name = block?.blockName ?? "";
    const isHeader = i === 0 || HEADER_BLOCK_RE.test(name);
    const evidence = scanBlockForLogo(html, isHeader);
    if (evidence) return { hasLogo: true, evidence };
  }
  return { hasLogo: false };
}

/** Caelo-hosted media path prefix — mirrors `MEDIA_URL_PREFIX`. */
const CAELO_MEDIA_PREFIX = "/_caelo/";
/** Reserved theme-asset placeholders for the logo (CLAUDE.md §2). */
const THEME_LOGO_PLACEHOLDER_RE = /\{\{\s*theme_logo(?:_dark)?_url\s*\}\}/i;

/**
 * Does the rebuilt chrome header reference a real logo? True when the
 * header HTML carries EITHER a `{{theme_logo_url}}` / `{{theme_logo_dark_url}}`
 * placeholder OR an `<img>` whose `src` points at Caelo media
 * (`/_caelo/…` — what `migrate_media` rewrites an imported logo to). A
 * bound theme logo asset is a third, DB-side signal the caller ORs in.
 *
 * Deliberately does NOT count a header `<img>` still pointing at the
 * SOURCE host as a pass — that would mean the logo was left hotlinked,
 * which is its own defect the media migration already surfaces. It does
 * count any `/_caelo/` `<img>`, since a migrated logo lands there.
 */
export function rebuiltHeaderHasLogoRef(headerHtml: string): boolean {
  if (headerHtml === "") return false;
  if (THEME_LOGO_PLACEHOLDER_RE.test(headerHtml)) return true;
  const slice =
    headerHtml.length > MAX_SCAN_CHARS ? headerHtml.slice(0, MAX_SCAN_CHARS) : headerHtml;
  const imgRe = /<img\b([^<>]*)>/gi;
  for (let m = imgRe.exec(slice); m !== null; m = imgRe.exec(slice)) {
    const src = SRC_ATTR_RE.exec(m[1] ?? "")?.[1] ?? "";
    if (src.includes(CAELO_MEDIA_PREFIX)) return true;
  }
  return false;
}

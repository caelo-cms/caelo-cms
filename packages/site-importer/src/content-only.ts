// SPDX-License-Identifier: MPL-2.0

/**
 * issue #424 — read-time content-only shaping for stored crawl pages.
 *
 * `get_import_page` reads deliver 40-50% ballast per page: the source
 * site's chrome (header/footer/nav — often TWICE, desktop + mobile DOM),
 * cookie-consent text, and raw WordPress preset-token noise
 * (`--wp--preset--color--pale-pink` …). During a mass rebuild that cost
 * multiplies by N pages. The run's boilerplate detection (issue #248)
 * already classified which subtrees are layout/template-owned chrome —
 * these helpers apply that classification AT READ TIME:
 *
 *   - {@link stripBoilerplateSubtrees} replays the detector's exact
 *     subtree walk on ONE page and removes the byte ranges whose
 *     signature matches a layout/template-placed candidate from the
 *     stored `import_runs.boilerplate_summary`;
 *   - {@link collapseDuplicateNavs} drops repeated nav DOM whose link
 *     text duplicates an earlier nav on the same page (the desktop +
 *     mobile double);
 *   - {@link filterPresetThemeTokens} filters the raw `:root` custom-
 *     property dump down to the preset tokens the page actually
 *     references (plus every non-preset token).
 *
 * Every helper returns loud counts — callers MUST surface them
 * (CLAUDE.md §2: stripping is never silent).
 */

import { Parser } from "htmlparser2";
import {
  type BoilerplatePlacement,
  collectSubtrees,
  DEFAULT_MIN_TEXT_LENGTH,
  normalizeText,
} from "./boilerplate.js";

/**
 * One candidate from a stored run boilerplate summary
 * (`import_runs.boilerplate_summary.candidates[]`), reduced to the fields
 * the read-time strip needs. `signature` is the detector's content
 * signature for `kind: "content"` candidates and its structural signature
 * for `kind: "structure"` ones.
 */
export interface BoilerplateStripTarget {
  readonly signature: string;
  readonly kind: "content" | "structure";
  readonly tag: string;
  readonly suggestedPlacement: BoilerplatePlacement;
  readonly sampleText: string;
}

/** One subtree removed by {@link stripBoilerplateSubtrees}, for the loud counter line. */
export interface StrippedChromeBlock {
  readonly placement: BoilerplatePlacement;
  readonly tag: string;
  readonly sampleText: string;
}

/**
 * Remove every subtree of `html` whose boilerplate signature matches a
 * layout- or template-placed FIXED-TEXT candidate.
 *
 * Two candidate families are deliberately NOT stripped:
 *   - `content_instance` placements — genuine shared content the rebuild
 *     must see;
 *   - `kind: "structure"` candidates (same structure, per-page text).
 *     Their text IS the page's content: every blog article shares its
 *     template's shape, so a structural match routinely covers the whole
 *     article body. Only byte-identical (`kind: "content"`) blocks carry
 *     zero per-page information and are chrome-safe to remove.
 *
 * The page's subtrees are re-signed with the SAME walk the detector used
 * (`collectSubtrees`, same min-text default), so a stored candidate maps
 * byte-exactly back onto this page. Removal is byte-range based like the
 * extraction strippers — surviving markup is untouched.
 *
 * @returns the stripped HTML plus one entry per removed subtree —
 *   callers MUST surface these (CLAUDE.md §2).
 */
export function stripBoilerplateSubtrees(
  html: string,
  targets: readonly BoilerplateStripTarget[],
): { html: string; stripped: StrippedChromeBlock[] } {
  const byContentSig = new Map<string, BoilerplateStripTarget>();
  for (const t of targets) {
    if (t.kind !== "content") continue;
    if (t.suggestedPlacement !== "layout" && t.suggestedPlacement !== "template") continue;
    byContentSig.set(t.signature, t);
  }
  if (byContentSig.size === 0) return { html, stripped: [] };

  const records = collectSubtrees({ pageId: "content-only", html }, DEFAULT_MIN_TEXT_LENGTH);
  const matches: Array<{ start: number; end: number; target: BoilerplateStripTarget }> = [];
  for (const r of records) {
    const target = byContentSig.get(r.contentSig);
    if (target) matches.push({ start: r.start, end: r.end, target });
  }
  if (matches.length === 0) return { html, stripped: [] };

  // Parse ranges nest or are disjoint — keep outermost matches only so a
  // matched block inside an already-removed block is not double-counted.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof matches = [];
  for (const m of matches) {
    const last = kept[kept.length - 1];
    if (last && m.start >= last.start && m.end <= last.end) continue;
    kept.push(m);
  }

  let out = "";
  let cursor = 0;
  const stripped: StrippedChromeBlock[] = [];
  for (const m of kept) {
    out += html.slice(cursor, m.start);
    cursor = Math.max(cursor, m.end);
    stripped.push({
      placement: m.target.suggestedPlacement,
      tag: m.target.tag,
      sampleText: m.target.sampleText,
    });
  }
  out += html.slice(cursor);
  return { html: out, stripped };
}

/**
 * Collapse duplicated navigation DOM within ONE page: source sites ship
 * the same menu twice (desktop nav + mobile/offcanvas clone), doubling
 * every menu item in the extracted text. The first occurrence of each
 * distinct nav (by normalized text) survives; later text-identical navs
 * are removed. Matches `<nav>` elements and `role="navigation"` only —
 * deliberately conservative, prose is never touched.
 *
 * @returns the collapsed HTML plus the number of removed duplicates —
 *   callers MUST surface the count (CLAUDE.md §2).
 */
export function collapseDuplicateNavs(html: string): { html: string; removed: number } {
  interface NavFrame {
    start: number;
    textParts: string[];
  }
  const navs: Array<{ start: number; end: number; text: string }> = [];
  let depth = 0;
  let navDepth = -1;
  let frame: NavFrame | null = null;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        depth += 1;
        const isNav = name === "nav" || (attrs.role ?? "").toLowerCase() === "navigation";
        if (navDepth === -1 && isNav) {
          navDepth = depth;
          frame = { start: parser.startIndex, textParts: [] };
        }
      },
      ontext(t) {
        if (frame !== null && t.trim().length > 0) frame.textParts.push(t);
      },
      onclosetag() {
        if (navDepth === depth && frame !== null) {
          navs.push({
            start: frame.start,
            end: parser.endIndex + 1,
            text: normalizeText(frame.textParts.join(" ")),
          });
          navDepth = -1;
          frame = null;
        }
        depth -= 1;
      },
    },
    { lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();

  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [];
  for (const nav of navs) {
    if (nav.text === "") continue; // icon-only navs carry no dedup signal
    if (seen.has(nav.text)) ranges.push([nav.start, nav.end]);
    else seen.add(nav.text);
  }
  if (ranges.length === 0) return { html, removed: 0 };
  let out = html;
  for (const [from, to] of ranges.reverse()) {
    out = out.slice(0, from) + out.slice(to);
  }
  return { html: out, removed: ranges.length };
}

/** WordPress theme.json emits EVERY configured preset as a `:root` custom
 *  property whether any page uses it — the enumerable-preset namespace,
 *  not a measurement. */
const PRESET_TOKEN_RE = /^--wp--preset--/;
const VAR_REF_RE = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

/**
 * Filter a raw `:root` custom-property dump (`extractThemeTokens` shape)
 * down to design values in actual use: every non-preset token survives,
 * while `--wp--preset--*` entries survive only when the page HTML
 * references them — via `var(...)`, via the block-theme preset classes
 * (`has-<slug>-color`, `has-<slug>-font-size`, …), or (transitively) from
 * a surviving token's value. WordPress dumps its whole configured preset
 * palette per page; unreferenced presets are noise, not ground truth.
 *
 * @param tokens the raw custom-property dump (key → value, keys keep their `--` prefix).
 * @param contentHtml the page HTML the tokens are read FOR — in content-only
 *   mode pass the stripped HTML so chrome-only presets don't survive.
 * @returns surviving tokens plus the dropped-preset count — callers MUST
 *   surface the count (CLAUDE.md §2).
 */
export function filterPresetThemeTokens(
  tokens: Readonly<Record<string, string>>,
  contentHtml: string,
): { tokens: Record<string, string>; droppedPresetTokens: number } {
  const entries = Object.entries(tokens);
  const presets = entries.filter(([k]) => PRESET_TOKEN_RE.test(k));
  if (presets.length === 0) return { tokens: { ...tokens }, droppedPresetTokens: 0 };

  const referenced = new Set<string>();
  const collectRefs = (s: string): void => {
    for (const m of s.matchAll(VAR_REF_RE)) {
      const name = m[1];
      if (name !== undefined) referenced.add(name);
    }
  };
  collectRefs(contentHtml);
  // Block themes consume presets through classes, not var(): a key
  // `--wp--preset--color--pale-pink` is in use when the page carries
  // `has-pale-pink-color` / `has-pale-pink-background-color` / etc.
  for (const [k] of presets) {
    const slug = k.split("--").pop();
    if (slug !== undefined && slug !== "" && contentHtml.includes(`has-${slug}-`)) {
      referenced.add(k);
    }
  }

  const kept: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!PRESET_TOKEN_RE.test(k)) {
      kept[k] = v;
      collectRefs(v); // a semantic token may alias a preset — keep that preset too
    }
  }
  // Fixpoint over preset-to-preset aliases (`--wp--preset--color--brand:
  // var(--wp--preset--color--vivid-red)`): keeping one preset can make
  // another referenced. Bounded by the preset count, so it terminates.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [k, v] of presets) {
      if (kept[k] === undefined && referenced.has(k)) {
        kept[k] = v;
        collectRefs(v);
        changed = true;
      }
    }
  }
  const droppedPresetTokens = presets.filter(([k]) => kept[k] === undefined).length;
  return { tokens: kept, droppedPresetTokens };
}

// SPDX-License-Identifier: MPL-2.0

/**
 * issue #248 (WS2) — the content-inventory / no-information-loss check.
 *
 * The rebuild contract (skill migration 0130) says: content is sacred,
 * markup is rebuildable, improve-by-default. This module is the
 * ENFORCEMENT half — the deterministic loss check that keeps "improve"
 * from silently becoming "drop".
 *
 * "AI decides, code executes and verifies" (epic #149): the AI rebuilds
 * a page as clean modules; this code then proves that EVERY meaningful
 * content item from the source — headings, paragraphs, list items,
 * images, links, CTAs — reappears in the rebuild. Anything missing is
 * reported LOUDLY (never silently dropped) so the AI can surface a
 * deliberate drop with a reason, and the run report can flag the gap.
 *
 * Pure string/DOM analysis via htmlparser2 (already a dep). No model in
 * the loop; the same source + rebuild always yield the same report.
 */

import { Parser } from "htmlparser2";

/** The meaningful content classes the check tracks. */
export type ContentItemKind = "heading" | "paragraph" | "list_item" | "image" | "link" | "cta";

/**
 * One meaningful content item extracted from a page. `text` carries the
 * human-readable, whitespace-collapsed content (original case, for the
 * report); matching lowercases it. `href` / `src` carry the normalized
 * link target / image basename. `sourceContext` is the nearest preceding
 * heading, so a "missing" report points the AI at WHERE in the source
 * the dropped item lived.
 */
export interface ContentItem {
  readonly kind: ContentItemKind;
  readonly text?: string;
  readonly href?: string;
  /** Normalized image basename (last path segment, lowercased, query stripped). */
  readonly src?: string;
  /** The image src exactly as authored — kept so a report is actionable. */
  readonly rawSrc?: string;
  readonly sourceContext?: string;
}

export interface ContentInventory {
  readonly items: readonly ContentItem[];
}

/** An item present in the source but NOT found in the rebuild. */
export interface MissingContentItem {
  readonly kind: ContentItemKind;
  readonly text?: string;
  readonly href?: string;
  readonly src?: string;
  readonly sourceContext?: string;
}

export interface CoverageReport {
  readonly covered: readonly ContentItem[];
  readonly missing: readonly MissingContentItem[];
  readonly counts: {
    readonly total: number;
    readonly covered: number;
    readonly missing: number;
    readonly missingByKind: Readonly<Record<ContentItemKind, number>>;
  };
}

export interface CoverageOptions {
  /**
   * A source text/link/cta item is treated as covered when its normalized
   * text equals a rebuilt item's text, OR (for items at least this many
   * characters) when it appears as a substring of the rebuilt page's full
   * text. Substring matching absorbs benign reflow (one paragraph split
   * into two) without letting a short "Home" match spuriously. Default 12.
   */
  readonly minSubstringLen?: number;
  /**
   * Optional map of source image src → the migrated media URL the rebuild
   * should reference (issue #249 rewrites hotlinked assets). When present,
   * an image is covered if its migrated equivalent's basename appears in
   * the rebuild, even if the original host URL does not.
   */
  readonly migratedImageEquivalents?: Readonly<Record<string, string>>;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Tags whose text content is one matchable item. */
const TEXT_BLOCK_TAGS = new Set(["p", "li", "dd", "dt", "blockquote", "figcaption"]);
const CTA_TAGS = new Set(["button"]);
const CTA_CLASS_RE = /(^|[\s_-])(btn|button|cta|call-to-action)([\s_-]|$)/i;

/** Decode the handful of entities the extractor emits; safe single-level. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Whitespace-collapsed, entity-decoded, trimmed text — original case. */
export function collapseText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/** The matching key for a text: collapsed + lowercased. */
function normText(raw: string): string {
  return collapseText(raw).toLowerCase();
}

/**
 * Normalize a link href for cross-page matching: drop the fragment,
 * strip a trailing slash, lowercase. Internal links get rewritten during
 * migration (source URL → Caelo slug), so href matching is a secondary
 * signal to anchor-text matching — but an exact carry-over still matches.
 */
export function normHref(raw: string): string {
  let h = decodeEntities(raw).trim();
  const hash = h.indexOf("#");
  if (hash >= 0) h = h.slice(0, hash);
  h = h.replace(/\/+$/, "");
  return h.toLowerCase();
}

/**
 * The image's basename — last path segment, query/fragment removed,
 * lowercased. Media migration rewrites the host and directory but keeps
 * the filename, so the basename is the stable cross-rewrite signal.
 */
export function imageBasename(raw: string): string {
  let s = decodeEntities(raw).trim();
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  const seg = s.split("/").pop() ?? s;
  return seg.toLowerCase();
}

/** First non-empty src from a `srcset` value (before its width/density). */
function firstSrcsetUrl(srcset: string): string {
  const first = srcset.split(",")[0]?.trim() ?? "";
  return first.split(/\s+/)[0] ?? "";
}

interface Collector {
  kind: ContentItemKind;
  parts: string[];
  href?: string;
}

/**
 * Extract the meaningful content inventory from a page's HTML. Nested
 * text counts for every enclosing item (a link inside a paragraph yields
 * both a `link` and a `paragraph`), which is deliberate: the check must
 * prove the anchor text AND the surrounding prose both survived.
 */
export function extractContentInventory(html: string): ContentInventory {
  const items: ContentItem[] = [];
  const stack: Array<{ name: string; collector: Collector | null }> = [];
  let currentContext = "";

  const emit = (item: ContentItem): void => {
    items.push(item);
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const tag = name.toLowerCase();
        let collector: Collector | null = null;

        if (tag === "img") {
          const raw = attrs.src ?? (attrs.srcset ? firstSrcsetUrl(attrs.srcset) : "") ?? "";
          const src = imageBasename(raw);
          if (src) {
            emit({
              kind: "image",
              src,
              rawSrc: decodeEntities(raw).trim(),
              text: attrs.alt ? collapseText(attrs.alt) : undefined,
              sourceContext: currentContext || undefined,
            });
          }
        } else if (tag === "input") {
          const type = (attrs.type ?? "").toLowerCase();
          if (type === "submit" || type === "button") {
            const label = collapseText(attrs.value ?? "");
            if (label) {
              emit({ kind: "cta", text: label, sourceContext: currentContext || undefined });
            }
          }
        } else if (HEADING_TAGS.has(tag)) {
          collector = { kind: "heading", parts: [] };
        } else if (TEXT_BLOCK_TAGS.has(tag)) {
          collector = { kind: "paragraph", parts: [] };
          if (tag === "li") collector.kind = "list_item";
        } else if (tag === "a" && attrs.href !== undefined) {
          const cta = CTA_CLASS_RE.test(attrs.class ?? "") || (attrs.role ?? "") === "button";
          collector = { kind: cta ? "cta" : "link", parts: [], href: attrs.href };
        } else if (CTA_TAGS.has(tag)) {
          collector = { kind: "cta", parts: [] };
        }

        stack.push({ name: tag, collector });
      },
      ontext(t) {
        for (const frame of stack) {
          if (frame.collector) frame.collector.parts.push(t);
        }
      },
      onclosetag() {
        const frame = stack.pop();
        if (!frame?.collector) return;
        const c = frame.collector;
        const text = collapseText(c.parts.join(" "));
        if (c.kind === "heading" && text) currentContext = text;
        // A link/cta with no text but a real href is still meaningful.
        const hasContent = text.length > 0 || (c.href !== undefined && normHref(c.href).length > 0);
        if (!hasContent) return;
        emit({
          kind: c.kind,
          text: text || undefined,
          href: c.href !== undefined ? normHref(c.href) : undefined,
          sourceContext: currentContext || undefined,
        });
      },
    },
    { decodeEntities: false, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  return { items: dedupeItems(items) };
}

/** Stable key so identical items (a repeated nav link) collapse to one. */
function itemKey(item: {
  kind: ContentItemKind;
  text?: string;
  href?: string;
  src?: string;
}): string {
  return [
    item.kind,
    item.text ? normText(item.text) : "",
    item.href ? normHref(item.href) : "",
    item.src ?? "",
  ].join(" ");
}

function dedupeItems(items: readonly ContentItem[]): ContentItem[] {
  const seen = new Set<string>();
  const out: ContentItem[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Precomputed lookup structures over the rebuilt page. */
interface RebuiltIndex {
  readonly texts: ReadonlySet<string>;
  readonly hrefs: ReadonlySet<string>;
  readonly imageBasenames: ReadonlySet<string>;
  readonly combinedText: string;
}

function buildRebuiltIndex(rebuiltHtml: string): RebuiltIndex {
  const inv = extractContentInventory(rebuiltHtml);
  const texts = new Set<string>();
  const hrefs = new Set<string>();
  const imageBasenames = new Set<string>();
  for (const item of inv.items) {
    if (item.text) texts.add(normText(item.text));
    if (item.href) hrefs.add(item.href);
    if (item.src) imageBasenames.add(item.src);
  }
  // Full visible text (tags stripped, entities decoded) so a source
  // paragraph that the rebuild reflowed still matches by substring.
  const combinedText = normText(rebuiltHtml.replace(/<[^>]*>/g, " "));
  return { texts, hrefs, imageBasenames, combinedText };
}

function textCovered(text: string, index: RebuiltIndex, minSubstringLen: number): boolean {
  const n = normText(text);
  if (n.length === 0) return true;
  if (index.texts.has(n)) return true;
  return n.length >= minSubstringLen && index.combinedText.includes(n);
}

/**
 * Verify every source content item reappears in the rebuilt page. This is
 * the load-bearing check: `source` is the crawled inventory, `rebuiltHtml`
 * is the concatenated html of the rebuilt page's modules. Returns the
 * covered items plus a LOUD list of what went missing.
 */
export function checkInventoryCoverage(
  source: ContentInventory,
  rebuiltHtml: string,
  opts: CoverageOptions = {},
): CoverageReport {
  const minSubstringLen = opts.minSubstringLen ?? 12;
  const migrated = opts.migratedImageEquivalents ?? {};
  const index = buildRebuiltIndex(rebuiltHtml);

  const covered: ContentItem[] = [];
  const missing: MissingContentItem[] = [];
  const missingByKind: Record<ContentItemKind, number> = {
    heading: 0,
    paragraph: 0,
    list_item: 0,
    image: 0,
    link: 0,
    cta: 0,
  };

  for (const item of source.items) {
    let isCovered = false;

    switch (item.kind) {
      case "heading":
      case "paragraph":
      case "list_item":
        isCovered = item.text !== undefined && textCovered(item.text, index, minSubstringLen);
        break;
      case "link":
      case "cta": {
        const byHref =
          item.href !== undefined && item.href.length > 0 && index.hrefs.has(item.href);
        const byText = item.text !== undefined && textCovered(item.text, index, minSubstringLen);
        isCovered = byHref || byText;
        break;
      }
      case "image": {
        const base = item.src ?? "";
        const migratedTarget = item.rawSrc !== undefined ? migrated[item.rawSrc] : undefined;
        const migratedBase = migratedTarget ? imageBasename(migratedTarget) : "";
        isCovered =
          (base.length > 0 &&
            (index.imageBasenames.has(base) || index.combinedText.includes(base))) ||
          (migratedBase.length > 0 &&
            (index.imageBasenames.has(migratedBase) || index.combinedText.includes(migratedBase)));
        break;
      }
    }

    if (isCovered) {
      covered.push(item);
    } else {
      missingByKind[item.kind] += 1;
      missing.push({
        kind: item.kind,
        text: item.text,
        href: item.href,
        src: item.rawSrc ?? item.src,
        sourceContext: item.sourceContext,
      });
    }
  }

  return {
    covered,
    missing,
    counts: {
      total: source.items.length,
      covered: covered.length,
      missing: missing.length,
      missingByKind,
    },
  };
}

/**
 * Convenience wrapper: extract the source inventory from raw source HTML,
 * then check it against the rebuilt html in one call. The op path extracts
 * the source inventory separately (source content lives across several
 * import modules); tests and simple callers use this.
 */
export function checkContentCoverage(
  sourceHtml: string,
  rebuiltHtml: string,
  opts: CoverageOptions = {},
): CoverageReport {
  return checkInventoryCoverage(extractContentInventory(sourceHtml), rebuiltHtml, opts);
}

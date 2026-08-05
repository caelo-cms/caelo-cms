// SPDX-License-Identifier: MPL-2.0

/**
 * issue #415 — SINGLE-PAGE repeated-subtree dedup for the inspect cleanup
 * stage.
 *
 * The crawl-time detector (`detectBoilerplate`) finds blocks repeated
 * ACROSS pages; this finds blocks repeated WITHIN one page — carousel
 * clone slides, desktop+mobile nav duplicates the hidden-element pass
 * missed, a testimonial strip stamped three times — and removes every
 * occurrence after the first by byte range, so the surviving markup is
 * byte-identical to the source (no re-serialisation drift).
 *
 * Grouping is by CONTENT signature (structure + normalized text): only
 * true repeats fold; a structurally-similar block with different copy is
 * real content and survives. Because duplicates are byte-identical, the
 * FIRST occurrence of a group can never sit inside a removed range of an
 * enclosing group without an even-earlier twin surviving — one copy of
 * every repeated block always remains.
 *
 * Callers MUST surface `removed` (CLAUDE.md §2 — never strip silently).
 */

import { collectSubtrees, type SubtreeRecord } from "./boilerplate.js";

/** Result of {@link stripRepeatedSubtrees}. */
export interface RepeatedSubtreeStrip {
  readonly html: string;
  /**
   * Number of removed CONTIGUOUS duplicate regions, after merging nested /
   * overlapping duplicate ranges — a cloned section that itself contains
   * cloned cards counts ONCE, not once per inner clone. This is the number
   * the operator-facing counters line reports ("N repeated block(s)"), so
   * it must match what a reader would perceive as distinct removed blocks.
   * Surviving first occurrences are never counted.
   */
  readonly removed: number;
}

/**
 * Page-builder div-soup nests carousels 10+ block levels deep; the crawl
 * walker's cap of 8 open frames would never record the clone slides. A
 * single page can afford the larger (still constant) per-event cost.
 */
const SINGLE_PAGE_MAX_FRAMES = 24;

interface Range {
  start: number;
  end: number;
}

/**
 * Remove same-page duplicate block subtrees from `html`, keeping the first
 * occurrence of each repeated group.
 *
 * @param opts.minTextLength — a subtree must carry at least this much
 *   visible text (or a link/img) to qualify, mirroring `detectBoilerplate`'s
 *   gate; default 20.
 */
export function stripRepeatedSubtrees(
  html: string,
  opts: { readonly minTextLength?: number } = {},
): RepeatedSubtreeStrip {
  const records = collectSubtrees(
    { pageId: "single-page", html },
    opts.minTextLength ?? 20,
    SINGLE_PAGE_MAX_FRAMES,
  );

  const groups = new Map<string, SubtreeRecord[]>();
  for (const r of records) {
    const g = groups.get(r.contentSig);
    if (g) g.push(r);
    else groups.set(r.contentSig, [r]);
  }

  const ranges: Range[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.start - b.start);
    for (const dup of g.slice(1)) ranges.push({ start: dup.start, end: dup.end });
  }
  if (ranges.length === 0) return { html, removed: 0 };

  // A duplicate may enclose another group's duplicate (a cloned section
  // containing a cloned card). Merge overlapping/contained ranges so each
  // byte is sliced out once and `removed` counts DISTINCT removed blocks —
  // the number the operator-facing counter line reports.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start < last.end) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    merged.push({ start: r.start, end: r.end });
  }

  let out = html;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const r = merged[i];
    if (r !== undefined) out = out.slice(0, r.start) + out.slice(r.end);
  }
  return { html: out, removed: merged.length };
}

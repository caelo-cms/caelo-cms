// SPDX-License-Identifier: MPL-2.0

/**
 * Snippets and highlights (epic #1644, R3).
 *
 * A hit shows the passage that best matches the query, cut to a window
 * around its first match, with highlight ranges as character offsets into
 * the returned text. Ranges, not markup: the browser builds the `<mark>`
 * elements itself, so a page's text can never inject HTML into results.
 *
 * A word matches when its exact folded form or its stem is one the query
 * searched for. Passages score by exact matches (1) and stem matches (0.6),
 * the same order the ranking uses; the passage's heading counts double.
 */

import { foldDiacritics, primaryLanguage, stemWord } from "./analyze.js";
import type { Passage } from "./schema.js";
import type { QueryTerms } from "./search.js";

/** A cut text with highlight ranges `[start, end)` into it. */
export interface Highlighted {
  readonly text: string;
  readonly highlights: readonly (readonly [number, number])[];
}

/** The snippet of one hit. */
export interface Snippet {
  readonly anchor: string;
  readonly heading: Highlighted;
  readonly text: Highlighted;
  readonly passage: number;
}

const segmenters = new Map<string, Intl.Segmenter>();

function words(text: string, lang: string): { start: number; end: number; exact: string }[] {
  const primary = primaryLanguage(lang);
  let seg = segmenters.get(primary);
  if (!seg) {
    seg = new Intl.Segmenter(primary, { granularity: "word" });
    segmenters.set(primary, seg);
  }
  const out: { start: number; end: number; exact: string }[] = [];
  for (const part of seg.segment(text)) {
    if (!part.isWordLike) continue;
    out.push({
      start: part.index,
      end: part.index + part.segment.length,
      exact: foldDiacritics(part.segment.normalize("NFKC").toLocaleLowerCase(primary)),
    });
  }
  return out;
}

function matcher(terms: QueryTerms, lang: string): (exact: string) => number {
  const exact = new Set(terms.exact);
  const stems = new Set(terms.stems);
  return (w) => {
    if (exact.has(w)) return 1;
    const s = stemWord(w, lang);
    return s !== null && stems.has(s) ? 0.6 : 0;
  };
}

/** Highlights every matching word of a short text (a title). */
export function highlight(text: string, terms: QueryTerms, lang: string): Highlighted {
  const match = matcher(terms, lang);
  const highlights: [number, number][] = [];
  for (const w of words(text, lang)) if (match(w.exact) > 0) highlights.push([w.start, w.end]);
  return { text, highlights };
}

/**
 * The best passage of a document for a query, cut to about `maxChars`
 * around its first match; the first passage, cut from its start, when no
 * passage matches. Null for a document without passages.
 */
export function snippet(
  passages: readonly Passage[],
  terms: QueryTerms,
  lang: string,
  maxChars = 220,
  preferPassage?: number,
): Snippet | null {
  if (passages.length === 0) return null;
  const match = matcher(terms, lang);
  let best = preferPassage !== undefined && preferPassage < passages.length ? preferPassage : 0;
  let bestScore = -1;
  if (preferPassage === undefined) {
    passages.forEach((p, i) => {
      let score = 0;
      for (const w of words(p.heading, lang)) score += 2 * match(w.exact);
      for (const w of words(p.text.slice(0, 20_000), lang)) score += match(w.exact);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
  }
  const p = passages[best] as Passage;
  return {
    anchor: p.anchor,
    heading: highlight(p.heading, terms, lang),
    text: cut(p.text, lang, maxChars, match),
    passage: best,
  };
}

function cut(
  text: string,
  lang: string,
  maxChars: number,
  match: (w: string) => number,
): Highlighted {
  const all = words(text, lang);
  const first = all.find((w) => match(w.exact) > 0);
  let start = 0;
  if (first && first.start > maxChars / 3) {
    start = first.start - Math.floor(maxChars / 3);
    const boundary = all.find((w) => w.start >= start);
    start = boundary ? boundary.start : start;
  }
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const lastWord = [...all].reverse().find((w) => w.end <= end);
    if (lastWord && lastWord.end > start) end = lastWord.end;
  }
  const prefix = start > 0 ? "… " : "";
  const suffix = end < text.length ? " …" : "";
  const body = text.slice(start, end);
  const highlights: [number, number][] = [];
  for (const w of all) {
    if (w.start < start || w.end > end) continue;
    if (match(w.exact) > 0)
      highlights.push([w.start - start + prefix.length, w.end - start + prefix.length]);
  }
  return { text: prefix + body + suffix, highlights };
}

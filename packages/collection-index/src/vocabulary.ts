// SPDX-License-Identifier: MPL-2.0

/**
 * Segment vocabulary files (epic #1644, R2): the real words of a segment,
 * split by first character so a typo lookup or a compound split loads one
 * small file, not the dictionary.
 *
 * A word joins the vocabulary when it occurs on at least two documents of a
 * large segment (a misspelling in content usually occurs once), or on one
 * document of a small delta segment, whose words the next merge re-judges.
 */

import { ByteReader, ByteWriter } from "./bytes.js";

/** One vocabulary word and its document frequency. */
export interface VocabularyWord {
  readonly word: string;
  readonly df: number;
}

/** The bucket of a word: its first character when it is a-z or 0-9, `_` otherwise. */
export function vocabularyBucket(word: string): string {
  const c = word[0] ?? "_";
  return /[a-z0-9]/.test(c) ? c : "_";
}

/** Encodes one bucket's words, sorted. */
export function encodeVocabulary(words: readonly (readonly [string, number])[]): Uint8Array {
  const sorted = [...words].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const w = new ByteWriter(sorted.length * 10 + 8);
  w.uint(sorted.length);
  for (const [word, df] of sorted) {
    w.string(word);
    w.uint(df);
  }
  return w.finish();
}

/** Decodes a vocabulary file. */
export function decodeVocabulary(data: Uint8Array): VocabularyWord[] {
  const r = new ByteReader(data);
  return Array.from({ length: r.uint() }, () => ({ word: r.string(), df: r.uint() }));
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent
 * transposition), or `max + 1` as soon as it must exceed `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_v, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, (prev2[j - 2] as number) + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[n] as number;
}

/** Edits a word of this length may have and still count as a typo of a vocabulary word. */
export function allowedEdits(length: number): number {
  if (length < 4) return 0;
  return length < 8 ? 1 : 2;
}

/**
 * The vocabulary word closest to `word`: fewest edits, then most documents.
 * Null when none is within the allowed edits.
 */
export function closestWord(
  word: string,
  candidates: readonly VocabularyWord[],
): VocabularyWord | null {
  const max = allowedEdits(word.length);
  if (max === 0) return null;
  let best: VocabularyWord | null = null;
  let bestDistance = max + 1;
  for (const c of candidates) {
    if (c.word === word) return c;
    if (Math.abs(c.word.length - word.length) > max) continue;
    const d = editDistance(word, c.word, Math.min(max, bestDistance));
    if (d < bestDistance || (d === bestDistance && best !== null && c.df > best.df)) {
      if (d <= max) {
        best = c;
        bestDistance = d;
      }
    }
  }
  return best;
}

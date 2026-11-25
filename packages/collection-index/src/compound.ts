// SPDX-License-Identifier: MPL-2.0

/**
 * German compound splitting against the collection's own vocabulary
 * (epic #1644, R2).
 *
 * "Preisliste" is split into "preis" + "liste" only when both parts are
 * words the site itself uses; a split never invents a word. Linking
 * elements ("Arbeit-s-zeit", "Bund-es-land", "Sonne-n-schein") are tried
 * after the first part. Among valid splits the one whose parts are most
 * frequent wins (the geometric mean of their document frequencies, after
 * Koehn and Knight 2003), so "Wachstube" follows the site's own usage.
 *
 * Only folded ASCII words of at least 8 letters are tried, and each part
 * needs 4 letters, which keeps short words and accidental splits out.
 */

const LINKING = ["", "s", "es", "n", "en", "er", "e"] as const;

/** Shortest word tried. */
export const MIN_COMPOUND_LENGTH = 8;

/** Shortest part accepted. */
export const MIN_PART_LENGTH = 4;

/**
 * The best two-part split of `word`, or null. `df` returns a word's
 * document frequency in the vocabulary, 0 for an unknown word.
 */
export function splitCompound(
  word: string,
  df: (w: string) => number,
): readonly [string, string] | null {
  if (word.length < MIN_COMPOUND_LENGTH || !/^[a-z]+$/.test(word)) return null;
  let best: readonly [string, string] | null = null;
  let bestScore = 0;
  for (let i = MIN_PART_LENGTH; i <= word.length - MIN_PART_LENGTH; i++) {
    const head = word.slice(0, i);
    const headDf = df(head);
    if (headDf === 0) continue;
    for (const link of LINKING) {
      if (!word.startsWith(link, i)) continue;
      const tail = word.slice(i + link.length);
      if (tail.length < MIN_PART_LENGTH) continue;
      const tailDf = df(tail);
      if (tailDf === 0) continue;
      const score = Math.sqrt(headDf * tailDf);
      if (score > bestScore) {
        bestScore = score;
        best = [head, tail];
      }
    }
  }
  return best;
}

/** First characters of every possible second part of `word`: the vocabulary buckets a query-side split needs. */
export function compoundTailInitials(word: string): string[] {
  if (word.length < MIN_COMPOUND_LENGTH || !/^[a-z]+$/.test(word)) return [];
  const out = new Set<string>();
  for (let i = MIN_PART_LENGTH; i <= word.length - MIN_PART_LENGTH; i++)
    for (const link of LINKING) {
      const at = i + link.length;
      if (word.startsWith(link, i) && word.length - at >= MIN_PART_LENGTH)
        out.add(word[at] as string);
    }
  return [...out];
}

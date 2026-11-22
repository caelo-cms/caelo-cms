// SPDX-License-Identifier: MPL-2.0

/**
 * The gap report (issue #1655): which questions the site does not answer.
 *
 * Visitors' ratings arrive in the plugin's inbox (`feedback`, a declared
 * insert): helpful, not helpful, or unanswered (an answer the gateway gave
 * without a source). A daily batch folds the last 30 days into clusters of
 * similar questions — "18 questions about shipping to Switzerland, no page
 * answers them" — for the operator's AI to propose content or a synonym.
 *
 * Everything here is visitors' text: data, never instructions. It is
 * clustered by its words only (no model reads it here), and the report
 * that reaches the admin AI is marked untrusted.
 *
 * Clustering groups phrasings of one question, not meanings: each
 * question's content words (lowercased, diacritics folded, stop words and
 * short words out, a light suffix trim) are compared by their first five
 * letters, so "Versandkosten" meets "Versand". A question joins the cluster
 * it shares the most words with, when that is at least two of them (one for
 * a one-word question) and at least half of its own; else it starts one.
 * Synonyms ("liefert", "Versand") stay apart: the AI that reads the report
 * groups meanings. A prefix index keeps it linear in the questions, and
 * clusters are bounded, so a flood of distinct questions stays bounded too.
 */

/** One stored rating, as the inbox keeps it. */
export interface FeedbackEvent {
  readonly kind: "helpful" | "not_helpful" | "unanswered";
  readonly question: string | null;
  readonly note: string | null;
  readonly lang: string;
  readonly day: string;
}

/** One cluster of similar questions the site did not answer well. */
export interface Gap {
  /** Stable key of the cluster: its sorted top words and language. */
  readonly key: string;
  readonly lang: string;
  /** The words the questions share most, most frequent first. */
  readonly words: readonly string[];
  /** Up to three questions of the cluster, as visitors wrote them. */
  readonly samples: readonly string[];
  /** Up to three notes visitors added. */
  readonly notes: readonly string[];
  readonly unanswered: number;
  readonly notHelpful: number;
  /** Days with at least one such question. */
  readonly days: number;
  /** What the operator's AI should look at first. */
  readonly suggestion: "missing-page" | "weak-answer";
}

/** Clusters kept per language: a flood of distinct questions stays bounded. */
export const MAX_CLUSTERS = 500;

/** A cluster reported: at least this many negative ratings. */
export const MIN_GAP_COUNT = 3;

const STOP = new Set(
  (
    "a an and are as at be but by can do does for from has have how i in is it its me my of on or our so that the their there this to was we what when where which who why will with you your " +
    "aber als am an auch auf aus bei bin bis da das dass dein der des die dir du ein eine einem einen einer es fur gibt hab habe haben hat ich ihr im in ist ja kann kann man mein mich mir mit nach nicht noch nur ob oder sie sind so uber um und uns unser von vor was welche wenn wer wie wir wird wo zu zum zur " +
    "le la les de des du un une et est en que qui pour pas sur au avec ce il je vous nous el los las del y es por para con una que se"
  ).split(" "),
);

/** `text` lowercased with diacritics folded (ü → u, é → e). */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

/** A light, language-neutral suffix trim: "versandkosten" and "versandkosten?" are one word, "preise" and "preis" too. */
function trim(word: string): string {
  for (const suffix of ["ungen", "ung", "en", "es", "er", "e", "s"])
    if (word.length - suffix.length >= 4 && word.endsWith(suffix))
      return word.slice(0, -suffix.length);
  return word;
}

/**
 * The content words of a question. Splits on everything that is not a
 * letter or a digit (one pass, no backtracking), keeps words of 3 to 40
 * characters that are not stop words, at most 12.
 */
export function questionWords(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of fold(question).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || raw.length > 40 || STOP.has(raw)) continue;
    const w = trim(raw);
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length === 12) break;
  }
  return out;
}

/** The part of a word two spellings of it share ("versandkost" and "versand": "versa"). */
const stemKey = (word: string): string => word.slice(0, 5);

interface Building {
  lang: string;
  counts: Map<string, number>;
  samples: string[];
  notes: string[];
  unanswered: number;
  notHelpful: number;
  days: Set<string>;
}

/**
 * Folds the negative ratings (not helpful, unanswered) of `events` into
 * clusters of similar questions, the largest first. Helpful ratings and
 * ratings without a question count for nothing here.
 */
export function clusterGaps(events: readonly FeedbackEvent[]): Gap[] {
  const clusters: Building[] = [];
  // Language and stem key → the clusters that have a word with that key.
  const byKey = new Map<string, Set<number>>();
  for (const e of events) {
    if (e.kind === "helpful" || !e.question) continue;
    const words = questionWords(e.question);
    if (words.length === 0) continue;
    const lang = (e.lang.split("-")[0] ?? e.lang).toLowerCase();
    const keys = [...new Set(words.map((w) => `${lang}|${stemKey(w)}`))];
    const shared = new Map<number, number>();
    for (const k of keys)
      for (const i of byKey.get(k) ?? []) shared.set(i, (shared.get(i) ?? 0) + 1);
    const need = Math.max(Math.min(2, keys.length), Math.ceil(keys.length / 2));
    let best = -1;
    let bestShared = 0;
    for (const [i, n] of shared)
      if (n >= need && (n > bestShared || (n === bestShared && i < best))) {
        best = i;
        bestShared = n;
      }
    let target: Building;
    if (best >= 0) target = clusters[best] as Building;
    else {
      if (clusters.length >= MAX_CLUSTERS) continue;
      target = {
        lang,
        counts: new Map(),
        samples: [],
        notes: [],
        unanswered: 0,
        notHelpful: 0,
        days: new Set(),
      };
      best = clusters.length;
      clusters.push(target);
    }
    for (const k of keys) {
      const set = byKey.get(k) ?? new Set<number>();
      set.add(best);
      byKey.set(k, set);
    }
    for (const w of words) target.counts.set(w, (target.counts.get(w) ?? 0) + 1);
    if (target.samples.length < 3 && !target.samples.includes(e.question.trim()))
      target.samples.push(e.question.trim().slice(0, 300));
    if (e.note && target.notes.length < 3) target.notes.push(e.note.trim().slice(0, 300));
    if (e.kind === "unanswered") target.unanswered++;
    else target.notHelpful++;
    target.days.add(e.day);
  }
  return clusters
    .filter((c) => c.unanswered + c.notHelpful >= MIN_GAP_COUNT)
    .map((c) => {
      const words = [...c.counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([w]) => w);
      return {
        key: `${c.lang}|${[...words].sort().join(" ")}`,
        lang: c.lang,
        words,
        samples: c.samples,
        notes: c.notes,
        unanswered: c.unanswered,
        notHelpful: c.notHelpful,
        days: c.days.size,
        suggestion:
          c.unanswered >= c.notHelpful ? ("missing-page" as const) : ("weak-answer" as const),
      };
    })
    .sort((a, b) => b.unanswered + b.notHelpful - (a.unanswered + a.notHelpful));
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Search over an open release (epic #1644, R3).
 *
 * Words: BM25F over the schema's slots. Every query word is one group with
 * one IDF (from the documents holding any of its forms), and its forms add
 * weighted occurrences to one term frequency before BM25F saturates it once:
 *
 *   every word with the same stem counts `stemWeight` — "Preise" finds
 *   "Preis" and "Preisen";
 *   the exact spellings count 1 on top — "uebersicht" also tries
 *   "ubersicht" — so the exact form ranks first in the same slot;
 *   compound parts count `compoundWeight` — "Preis" finds "Preisliste".
 *
 * One IDF per word matters: with an IDF per form, a rare exact form in a
 * body text outranks a common inflection in a title, which is backwards.
 * Visible synonyms (`synonymWeight`) and, for the last word, prefix
 * completions (`prefixWeight`, only from slots declared with `prefix`) are
 * groups of their own: they are other words.
 *
 * A word that matches nothing is first tried as a compound of two
 * vocabulary words ("logfileanalyse" → "logfile analyse"), then corrected
 * to the closest vocabulary word within one or two edits. Both are reported
 * back, so a results page can say what it searched for.
 *
 * Scores accumulate in one dense array per segment, indexed by document
 * position; postings and document keys both ascend, so a merge walk maps one
 * to the other. Measured at 50,000 pages (#1652): warm p50 1.3 ms, p95 6 ms
 * on one core, so exhaustive scoring meets the targets without WAND-style
 * pruning; the longest posting list cannot exceed the page count.
 *
 * Vectors: the query embedding ranks passages (see vectors.ts); a document
 * scores by its best passage, and only passages at or above
 * `minSimilarity` count. `fuse` merges the word and vector rankings by
 * Reciprocal Rank Fusion.
 */

import { type AnalyzerOptions, analyze, queryVariants, STEM_PREFIX, stemWord } from "./analyze.js";
import { compoundTailInitials, splitCompound } from "./compound.js";
import { DEFAULT_PROBE, listScore, nearestLists } from "./partitions.js";
import type { OpenRelease } from "./release.js";
import { keywordTerm, langTerm } from "./schema.js";
import { docPosition, type ParsedDocs, type PostingList, VECTORS_PER_BLOCK } from "./segment.js";
import { defaultRescore, hammingCandidates, int8Score, normalize } from "./vectors.js";
import { closestWord, type VocabularyWord } from "./vocabulary.js";
import { COMPOUND_PREFIX } from "./writer.js";

/** Document filters. Keyword values are OR within a field and AND across fields. */
export interface SearchFilter {
  readonly langs?: readonly string[];
  readonly keywords?: Readonly<Record<string, readonly string[]>>;
  readonly excludeKeywords?: Readonly<Record<string, readonly string[]>>;
  readonly ranges?: Readonly<Record<string, { readonly gte?: number; readonly lte?: number }>>;
}

/** Ranking parameters with their starting values. */
export interface SearchTuning {
  readonly k1: number;
  readonly b: number;
  readonly stemWeight: number;
  readonly compoundWeight: number;
  readonly synonymWeight: number;
  readonly prefixWeight: number;
  readonly prefixExpansions: number;
  readonly prefixMinLength: number;
  readonly typoWeight: number;
}

/** Starting values; a plugin's config overrides them per field. */
export const DEFAULT_TUNING: SearchTuning = {
  k1: 1.2,
  b: 0.75,
  stemWeight: 0.6,
  compoundWeight: 0.35,
  synonymWeight: 0.8,
  prefixWeight: 0.5,
  prefixExpansions: 8,
  prefixMinLength: 3,
  typoWeight: 0.8,
};

/** One word query. */
export interface TextQuery extends AnalyzerOptions {
  readonly text: string;
  /** Language the query is analysed in. */
  readonly lang: string;
  /** Weight per slot name ("title", "sections.heading", "sections.text"); a slot not named weighs 0. */
  readonly weights: Readonly<Record<string, number>>;
  readonly filter?: SearchFilter;
  readonly limit: number;
  readonly offset?: number;
  readonly facets?: readonly string[];
  readonly prefix?: boolean;
  readonly typos?: boolean;
  readonly compounds?: boolean;
  /** Synonyms per folded word, each searched like a query word. */
  readonly synonyms?: ReadonlyMap<string, readonly string[]>;
  readonly tuning?: Partial<SearchTuning>;
}

/** One ranked document. */
export interface Hit {
  readonly key: number;
  readonly score: number;
}

/** A facet value and how many matching documents carry it. */
export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

/** What a word query found. */
export interface TextResult {
  readonly hits: readonly Hit[];
  readonly total: number;
  readonly facets: Readonly<Record<string, readonly FacetCount[]>>;
  /** Words corrected for typos: what was typed and what was searched. */
  readonly corrections: readonly { readonly from: string; readonly to: string }[];
  /** Words split as compounds. */
  readonly splits: readonly { readonly from: string; readonly parts: readonly [string, string] }[];
  /** Analysed query words, exact and stem, for snippets. */
  readonly terms: QueryTerms;
}

/** The exact forms and stems a query searched for, for highlighting. */
export interface QueryTerms {
  readonly exact: readonly string[];
  readonly stems: readonly string[];
}

interface GroupPart {
  readonly terms: readonly string[];
  readonly tfWeight: number;
}

interface QueryGroup {
  readonly parts: readonly GroupPart[];
  readonly weight: number;
  readonly word: number;
}

/** A posting list whose frequencies are weighted sums of several terms' frequencies. */
interface WeightedList {
  readonly keys: Uint32Array;
  readonly tf: Float32Array;
}

interface SegmentState {
  readonly docs: ParsedDocs;
  readonly allowed: Uint8Array | null;
  scores: Float64Array | null;
}

/** Throws unless every weighted slot exists, so a declaration that drifted from its schema fails loudly. */
function slotWeights(
  release: OpenRelease,
  weights: Readonly<Record<string, number>>,
): Float64Array {
  const slots = release.segments[0]?.reader.manifest.slots ?? [];
  for (const name of Object.keys(weights)) {
    if (!slots.includes(name))
      throw new RangeError(
        `search: "${name}" is not a searchable slot of this collection (slots: ${slots.join(", ")})`,
      );
  }
  return Float64Array.from(slots, (s) => weights[s] ?? 0);
}

function stemGroup(exact: string, q: TextQuery): string[] {
  const s = stemWord(exact, q.lang, q);
  if (s === null) return [];
  const terms = [STEM_PREFIX + s];
  if (stemWord(s, q.lang, q) === s) terms.push(s);
  return terms;
}

function wordGroup(
  exact: string,
  weight: number,
  word: number,
  q: TextQuery,
  t: SearchTuning,
): QueryGroup {
  const spellings = [exact, ...queryVariants(exact, q.lang)];
  const parts: GroupPart[] = [{ terms: spellings, tfWeight: 1 }];
  const stems = [...new Set(spellings.flatMap((w) => stemGroup(w, q)))];
  if (stems.length > 0) parts.push({ terms: stems, tfWeight: t.stemWeight });
  if (q.compounds ?? true) {
    const compound = new Set(spellings.map((w) => COMPOUND_PREFIX + w));
    for (const s of stems)
      if (s.startsWith(STEM_PREFIX)) compound.add(COMPOUND_PREFIX + s.slice(STEM_PREFIX.length));
    parts.push({ terms: [...compound], tfWeight: t.compoundWeight });
  }
  return { parts, weight, word };
}

/** Unites ascending posting lists, summing frequencies of a key that several lists hold. */
export function unitePostings(
  lists: readonly PostingList[],
  slotCount: number,
): PostingList | null {
  if (lists.length === 0) return null;
  if (lists.length === 1) return lists[0] as PostingList;
  const at = new Array<number>(lists.length).fill(0);
  const keys: number[] = [];
  const tf: number[] = [];
  for (;;) {
    let next = Number.POSITIVE_INFINITY;
    lists.forEach((l, i) => {
      const k = l.keys[at[i] as number];
      if (k !== undefined && k < next) next = k;
    });
    if (next === Number.POSITIVE_INFINITY) break;
    const row = new Array<number>(slotCount).fill(0);
    lists.forEach((l, i) => {
      const j = at[i] as number;
      if (l.keys[j] !== next) return;
      for (let f = 0; f < slotCount; f++)
        row[f] = (row[f] as number) + (l.tf[j * slotCount + f] as number);
      at[i] = j + 1;
    });
    keys.push(next);
    for (const v of row) tf.push(Math.min(v, 0xffff));
  }
  return { keys: Uint32Array.from(keys), tf: Uint16Array.from(tf) };
}

/** Calls `visit(postingIndex, docIndex)` for every posting, merging two ascending key arrays. */
function walk(
  list: { readonly keys: Uint32Array },
  docs: ParsedDocs,
  visit: (i: number, di: number) => void,
): void {
  const keys = docs.keys;
  let di = 0;
  for (let i = 0; i < list.keys.length; i++) {
    const key = list.keys[i] as number;
    while (di < keys.length && (keys[di] as number) < key) di++;
    if (di === keys.length) return;
    if (keys[di] === key) visit(i, di);
  }
}

/** Marks every document of a segment that passes the filter and is not removed; null when all pass. */
async function allowedMask(
  release: OpenRelease,
  si: number,
  docs: ParsedDocs,
  filter: SearchFilter | undefined,
): Promise<Uint8Array | null> {
  const seg = release.segments[si] as OpenRelease["segments"][number];
  const hasFilter =
    filter !== undefined &&
    ((filter.langs?.length ?? 0) > 0 ||
      Object.keys(filter.keywords ?? {}).length > 0 ||
      Object.keys(filter.excludeKeywords ?? {}).length > 0 ||
      Object.keys(filter.ranges ?? {}).length > 0);
  if (!hasFilter && seg.removed.size === 0) return null;
  const n = docs.keys.length;
  const mask = new Uint8Array(n).fill(1);
  for (const key of seg.removed) {
    const i = docPosition(docs, key);
    if (i >= 0) mask[i] = 0;
  }
  if (!filter) return mask;
  const restrictTo = async (terms: readonly string[], keep: boolean): Promise<void> => {
    const lists = (await Promise.all(terms.map((t) => seg.reader.postings(t)))).filter(
      (l): l is PostingList => l !== null,
    );
    const hit = new Uint8Array(n);
    for (const l of lists) walk(l, docs, (_i, di) => (hit[di] = 1));
    for (let i = 0; i < n; i++) if ((hit[i] === 1) !== keep) mask[i] = 0;
  };
  if (filter.langs && filter.langs.length > 0) await restrictTo(filter.langs.map(langTerm), true);
  for (const [field, values] of Object.entries(filter.keywords ?? {}))
    await restrictTo(
      values.map((v) => keywordTerm(field, v)),
      true,
    );
  for (const [field, values] of Object.entries(filter.excludeKeywords ?? {}))
    await restrictTo(
      values.map((v) => keywordTerm(field, v)),
      false,
    );
  for (const [field, range] of Object.entries(filter.ranges ?? {})) {
    const column = docs.numbers.get(field);
    if (!column)
      throw new RangeError(`search: "${field}" is not a number or date field of this collection`);
    for (let i = 0; i < n; i++) {
      const v = column[i] as number;
      if (
        Number.isNaN(v) ||
        (range.gte !== undefined && v < range.gte) ||
        (range.lte !== undefined && v > range.lte)
      )
        mask[i] = 0;
    }
  }
  return mask;
}

async function vocabularyFor(
  release: OpenRelease,
  initials: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const lists = await Promise.all(
    release.segments.flatMap((s) => [...new Set(initials)].map((c) => s.reader.vocabulary(c))),
  );
  for (const list of lists) for (const w of list) out.set(w.word, (out.get(w.word) ?? 0) + w.df);
  return out;
}

async function prefixCompletions(
  release: OpenRelease,
  prefix: string,
  slotMask: number,
  t: SearchTuning,
): Promise<string[]> {
  const seen = new Map<string, number>();
  const found = await Promise.all(
    release.segments.map((s) => s.reader.termsWithPrefix(prefix, t.prefixExpansions * 4)),
  );
  for (const list of found) {
    for (const { term, df, slotMask: m } of list) {
      if (term === prefix || (m & slotMask) === 0) continue;
      seen.set(term, (seen.get(term) ?? 0) + df);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, t.prefixExpansions)
    .map(([term]) => term);
}

type Lists = (WeightedList | null)[];

/** Unites weighted posting lists: per key and slot, the sum of weight × frequency. */
function uniteWeighted(
  lists: readonly { readonly list: PostingList; readonly weight: number }[],
  slotCount: number,
): WeightedList | null {
  if (lists.length === 0) return null;
  const keys = new Set<number>();
  for (const { list } of lists) for (const k of list.keys) keys.add(k);
  const sorted = Uint32Array.from(keys).sort();
  const index = new Map<number, number>();
  sorted.forEach((k, i) => {
    index.set(k, i);
  });
  const tf = new Float32Array(sorted.length * slotCount);
  for (const { list, weight } of lists) {
    for (let i = 0; i < list.keys.length; i++) {
      const at = (index.get(list.keys[i] as number) as number) * slotCount;
      for (let f = 0; f < slotCount; f++)
        tf[at + f] = (tf[at + f] as number) + weight * (list.tf[i * slotCount + f] as number);
    }
  }
  return { keys: sorted, tf };
}

/** Loads every posting list of every group in one parallel round, then unites them per group and segment. */
async function fetchGroups(
  release: OpenRelease,
  groups: readonly QueryGroup[],
  slotCount: number,
): Promise<Lists[]> {
  return Promise.all(
    groups.map((g) =>
      Promise.all(
        release.segments.map(async (s) => {
          const perPart = await Promise.all(
            g.parts.map(async (part) => ({
              part,
              found: await Promise.all(part.terms.map((t) => s.reader.postings(t))),
            })),
          );
          const lists: { list: PostingList; weight: number }[] = [];
          for (const { part, found } of perPart)
            for (const list of found) if (list) lists.push({ list, weight: part.tfWeight });
          return uniteWeighted(lists, slotCount);
        }),
      ),
    ),
  );
}

/** Runs a word query. */
export async function searchText(release: OpenRelease, q: TextQuery): Promise<TextResult> {
  const t: SearchTuning = { ...DEFAULT_TUNING, ...q.tuning };
  const empty: TextResult = {
    hits: [],
    total: 0,
    facets: {},
    corrections: [],
    splits: [],
    terms: { exact: [], stems: [] },
  };
  if (release.segments.length === 0) return empty;
  const weights = slotWeights(release, q.weights);
  const manifest0 = (release.segments[0] as OpenRelease["segments"][number]).reader.manifest;
  const nSlots = manifest0.slots.length;
  const prefixSlots = q.prefix ? prefixSlotMask(release) : 0;

  const tokens = analyze(q.text, q.lang, q);
  if (tokens.length === 0) return empty;
  const words = tokens.map((tk) => tk.exact);

  // The docs files, the prefix completions and, right after, the posting
  // lists load in parallel: a cold instance waits for two rounds of reads.
  const docsLoaded = Promise.all(release.segments.map((s) => s.reader.docs()));
  const lastIndex = words.length - 1;
  const last = words[lastIndex] as string;
  const completionsLoaded =
    q.prefix && prefixSlots !== 0 && last.length >= t.prefixMinLength
      ? prefixCompletions(release, last, prefixSlots, t)
      : Promise.resolve([]);

  const groups: QueryGroup[] = [];
  const corrections: { from: string; to: string }[] = [];
  const splits: { from: string; parts: readonly [string, string] }[] = [];
  const searchedExact = new Set<string>();
  const addWord = (exact: string, weight: number, word: number): void => {
    searchedExact.add(exact);
    groups.push(wordGroup(exact, weight, word, q, t));
    for (const synonym of q.synonyms?.get(exact) ?? []) {
      for (const s of analyze(synonym, q.lang, { ...q, keepStopwords: true })) {
        searchedExact.add(s.exact);
        groups.push(wordGroup(s.exact, weight * t.synonymWeight, word, q, t));
      }
    }
  };
  words.forEach((w, i) => {
    addWord(w, 1, i);
  });
  const wordLists = fetchGroups(release, groups, nSlots);
  const completions = await completionsLoaded;
  if (completions.length > 0)
    groups.push({
      parts: [{ terms: completions, tfWeight: 1 }],
      weight: t.prefixWeight,
      word: lastIndex,
    });
  const completionLists =
    completions.length > 0 ? fetchGroups(release, groups.slice(-1), nSlots) : Promise.resolve([]);

  const states: SegmentState[] = [];
  const allDocs = await docsLoaded;
  let docCount = 0;
  const sums = new Float64Array(nSlots);
  for (let si = 0; si < release.segments.length; si++) {
    const docs = allDocs[si] as ParsedDocs;
    const allowed = await allowedMask(release, si, docs, q.filter);
    const seg = release.segments[si] as OpenRelease["segments"][number];
    states.push({ docs, allowed, scores: null });
    docCount += docs.keys.length - seg.removed.size;
    seg.reader.manifest.slotLengthSums.forEach((n, f) => {
      sums[f] = (sums[f] as number) + n;
    });
  }
  if (docCount <= 0) return empty;
  const avg = Float64Array.from(sums, (n) => Math.max(n / docCount, 1));

  let lists = [...(await wordLists), ...(await completionLists)];
  const liveDf = (gi: number): number => {
    let df = 0;
    (lists[gi] as Lists).forEach((l, si) => {
      if (!l) return;
      const allowed = (states[si] as SegmentState).allowed;
      if (!allowed) df += l.keys.length;
      else walk(l, (states[si] as SegmentState).docs, (_i, di) => (df += allowed[di] as number));
    });
    return df;
  };
  const dfs = groups.map((_g, gi) => liveDf(gi));

  // Words that found nothing: compound split first, then typo correction.
  const unmatched = words
    .map((w, i) => ({ w, i }))
    .filter(({ i }) => groups.every((g, gi) => g.word !== i || (dfs[gi] as number) === 0));
  if (unmatched.length > 0 && ((q.compounds ?? true) || (q.typos ?? true))) {
    const initials = unmatched.flatMap(({ w }) => [w[0] as string, ...compoundTailInitials(w)]);
    const vocab = await vocabularyFor(release, initials);
    const extra: QueryGroup[] = [];
    for (const { w, i } of unmatched) {
      if (i === lastIndex && q.prefix) continue;
      const split =
        (q.compounds ?? true) && q.lang.toLowerCase().startsWith("de")
          ? splitCompound(w, (x) => vocab.get(x) ?? 0)
          : null;
      if (split) {
        splits.push({ from: w, parts: split });
        for (const part of split) {
          searchedExact.add(part);
          extra.push(wordGroup(part, 1, i, q, t));
        }
        continue;
      }
      if (!(q.typos ?? true)) continue;
      const candidates: VocabularyWord[] = [];
      for (const [word, df] of vocab) if (word[0] === w[0]) candidates.push({ word, df });
      const best = closestWord(w, candidates);
      if (best && best.word !== w) {
        corrections.push({ from: w, to: best.word });
        searchedExact.add(best.word);
        extra.push(wordGroup(best.word, t.typoWeight, i, q, t));
      }
    }
    if (extra.length > 0) {
      const extraLists = await fetchGroups(release, extra, nSlots);
      groups.push(...extra);
      lists = [...lists, ...extraLists];
      for (let gi = dfs.length; gi < groups.length; gi++) dfs.push(liveDf(gi));
    }
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const df = dfs[gi] as number;
    if (df === 0) continue;
    const g = groups[gi] as QueryGroup;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    (lists[gi] as Lists).forEach((list, si) => {
      if (!list) return;
      const state = states[si] as SegmentState;
      const lengths = state.docs.lengths;
      if (!state.scores) state.scores = new Float64Array(state.docs.keys.length);
      const scores = state.scores;
      const allowed = state.allowed;
      walk(list, state.docs, (i, di) => {
        if (allowed && allowed[di] === 0) return;
        let tf = 0;
        for (let f = 0; f < nSlots; f++) {
          const raw = list.tf[i * nSlots + f] as number;
          const w = weights[f] as number;
          if (raw === 0 || w === 0) continue;
          const len = lengths[di * nSlots + f] as number;
          tf += (w * raw) / (1 - t.b + (t.b * len) / (avg[f] as number));
        }
        if (tf > 0)
          scores[di] = (scores[di] as number) + g.weight * idf * ((tf * (t.k1 + 1)) / (tf + t.k1));
      });
    });
  }

  const offset = q.offset ?? 0;
  const { hits, total } = topK(states, q.limit + offset);
  const facets: Record<string, FacetCount[]> = {};
  for (const field of q.facets ?? []) facets[field] = facetCounts(states, field);
  const stems = new Set<string>();
  for (const w of searchedExact) {
    const s = stemWord(w, q.lang, q);
    if (s) stems.add(s);
  }
  return {
    hits: hits.slice(offset),
    total,
    facets,
    corrections,
    splits,
    terms: { exact: [...searchedExact], stems: [...stems] },
  };
}

function prefixSlotMask(release: OpenRelease): number {
  const manifest = release.segments[0]?.reader.manifest;
  const prefix = manifest?.prefixSlots ?? [];
  const slots = manifest?.slots ?? [];
  let mask = 0;
  slots.forEach((s, i) => {
    if (prefix.includes(s)) mask |= 1 << i;
  });
  return mask;
}

function topK(states: readonly SegmentState[], k: number): { hits: Hit[]; total: number } {
  const heap: Hit[] = [];
  let floor = 0;
  let total = 0;
  for (const state of states) {
    const scores = state.scores;
    if (!scores) continue;
    const keys = state.docs.keys;
    for (let di = 0; di < scores.length; di++) {
      const score = scores[di] as number;
      if (score <= 0) continue;
      total++;
      if (heap.length === k && score <= floor) continue;
      const hit = { key: keys[di] as number, score };
      if (heap.length < k) heap.push(hit);
      else heap[heap.length - 1] = hit;
      heap.sort((a, b) => b.score - a.score || a.key - b.key);
      floor = (heap[heap.length - 1] as Hit).score;
    }
  }
  return { hits: k === 0 ? [] : heap, total };
}

function facetCounts(states: readonly SegmentState[], field: string): FacetCount[] {
  const counts = new Map<string, number>();
  for (const state of states) {
    const column = state.docs.facets.get(field);
    if (!column) throw new RangeError(`search: "${field}" is not a facet field of this collection`);
    const scores = state.scores;
    if (!scores) continue;
    for (let di = 0; di < scores.length; di++) {
      if ((scores[di] as number) <= 0) continue;
      for (let j = column.starts[di] as number; j < (column.starts[di + 1] as number); j++) {
        const v = column.values[column.ordinals[j] as number] as string;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 50)
    .map(([value, count]) => ({ value, count }));
}

/** One vector query. */
export interface VectorQuery {
  readonly vector: Float32Array;
  readonly limit: number;
  readonly filter?: SearchFilter;
  /** Least cosine similarity a passage needs to count. */
  readonly minSimilarity: number;
  /** Binary candidates rescored with int8 per flat segment (default `defaultRescore` of its size). */
  readonly rescore?: number;
  /** Lists scored per partitioned segment (default `DEFAULT_PROBE`). */
  readonly probe?: number;
}

/** A document found by its best passage. */
export interface VectorHitDoc {
  readonly key: number;
  readonly passage: number;
  readonly similarity: number;
}

/** Ranks documents by their best passage's similarity to the query vector. */
export async function searchVectors(release: OpenRelease, q: VectorQuery): Promise<VectorHitDoc[]> {
  const query = normalize(q.vector);
  const best = new Map<number, VectorHitDoc>();
  // Segments read in parallel: a cold query waits for one round per step, not per segment.
  await Promise.all(
    release.segments.map(async (seg, si) => {
      const v = seg.reader.manifest.vectors;
      if (!v) return;
      if (v.dims !== query.length)
        throw new RangeError(
          `search: query vector has ${query.length} dimensions, the collection ${v.dims}`,
        );
      const docs = await seg.reader.docs();
      const allowed = await allowedMask(release, si, docs, q.filter);
      const skip = (key: number): boolean => {
        if (!allowed) return false;
        const di = docPosition(docs, key);
        return di < 0 || allowed[di] === 0;
      };
      const keep = (key: number, passage: number, similarity: number): void => {
        if (similarity < q.minSimilarity) return;
        const prev = best.get(key);
        if (!prev || similarity > prev.similarity) best.set(key, { key, passage, similarity });
      };
      if (v.partitions) {
        // #1783 — the nearest lists, read in one round, every passage in them scored with int8.
        const centroids = await seg.reader.centroids();
        const lists = await Promise.all(
          nearestLists(centroids, query, q.probe ?? DEFAULT_PROBE).map((li) => seg.reader.list(li)),
        );
        for (const list of lists) {
          for (let r = 0; r < list.count; r++) {
            const key = list.keys[r] as number;
            if (skip(key)) continue;
            keep(key, list.passages[r] as number, listScore(list, r, v.dims, query));
          }
        }
        return;
      }
      const files = await seg.reader.codeFiles();
      const candidates = hammingCandidates(
        files,
        query,
        q.rescore ?? defaultRescore(v.count),
        skip,
      );
      const blocks = [...new Set(candidates.map((c) => Math.floor(c.ordinal / VECTORS_PER_BLOCK)))];
      const loaded = new Map(
        await Promise.all(blocks.map(async (b) => [b, await seg.reader.vectorBlock(b)] as const)),
      );
      for (const c of candidates) {
        const file = files[c.file];
        if (!file) continue;
        const similarity = int8Score(
          loaded.get(Math.floor(c.ordinal / VECTORS_PER_BLOCK)) as Uint8Array,
          c.ordinal % VECTORS_PER_BLOCK,
          v.dims,
          query,
        );
        keep(file.keys[c.record] as number, file.passages[c.record] as number, similarity);
      }
    }),
  );
  return [...best.values()]
    .sort((a, b) => b.similarity - a.similarity || a.key - b.key)
    .slice(0, q.limit);
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ weight_i / (k + rank_i(d)). Rankings
 * are lists of keys, best first. `k` = 60 is the value from Cormack et al.
 * (2009) that later evaluations kept.
 */
export function fuse(
  rankings: readonly { readonly keys: readonly number[]; readonly weight: number }[],
  limit: number,
  k = 60,
): Hit[] {
  const scores = new Map<number, number>();
  for (const r of rankings) {
    r.keys.forEach((key, rank) => {
      scores.set(key, (scores.get(key) ?? 0) + r.weight / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || a.key - b.key)
    .slice(0, limit);
}

/**
 * The live keys holding each term, across a release (#1779): what a
 * keyword's postings say, without reading a stored document. A search
 * resolves boosts and link-text targets this way.
 */
export async function keysOfTerms(
  release: OpenRelease,
  terms: readonly string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>(terms.map((t) => [t, []]));
  await Promise.all(
    release.segments.map(async (seg) => {
      const lists = await Promise.all(terms.map((t) => seg.reader.postings(t)));
      lists.forEach((list, i) => {
        if (!list) return;
        const keys = out.get(terms[i] as string) as number[];
        for (const k of list.keys) if (!seg.removed.has(k)) keys.push(k);
      });
    }),
  );
  return out;
}

/**
 * The keys of `keys` that are live and pass `filter` (#1779): from the docs
 * file and the filter's postings, as a search filters, never from stored
 * documents.
 */
export async function keysPassing(
  release: OpenRelease,
  keys: readonly number[],
  filter: SearchFilter | undefined,
): Promise<Set<number>> {
  const out = new Set<number>();
  if (keys.length === 0) return out;
  await Promise.all(
    release.segments.map(async (seg, si) => {
      const m = seg.reader.manifest;
      const mine = keys.filter((k) => k >= m.firstKey && k <= m.lastKey && !seg.removed.has(k));
      if (mine.length === 0) return;
      const docs = await seg.reader.docs();
      const allowed = await allowedMask(release, si, docs, filter);
      for (const k of mine) {
        const at = docPosition(docs, k);
        if (at >= 0 && (!allowed || allowed[at] === 1)) out.add(k);
      }
    }),
  );
  return out;
}

// SPDX-License-Identifier: MPL-2.0

/**
 * A deterministic synthetic site for the search benchmark (#1652).
 *
 * Lemmas are pronounceable words with a Zipf frequency (exponent 1.07, the
 * shape of real web text), so posting lists have realistic lengths: a few
 * terms on most pages, a long tail on one or two. Each occurrence gets an
 * inflection ending of its language, so the stemmer folds forms the way it
 * would on real text. Page length is log-normal (median about 550 words).
 *
 * The text is what the indexing rules let through: chrome is already out;
 * text of modules on 11 to 49 pages lands in the `shared` field, which
 * ranks lower; anchor texts of links pointing at the page land in
 * `anchors`.
 */

import type { CollectionDoc, CollectionSchema, Passage } from "../src/index.js";

/** Mulberry32: small, fast, seeded. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSETS = [
  "b",
  "d",
  "f",
  "g",
  "h",
  "k",
  "l",
  "m",
  "n",
  "p",
  "r",
  "s",
  "t",
  "w",
  "z",
  "br",
  "kr",
  "st",
  "sch",
  "pl",
  "tr",
  "gr",
  "fl",
  "sp",
];
const VOWELS = ["a", "e", "i", "o", "u", "ei", "au", "ie", "ä", "ö", "ü"];
const CODAS = ["", "n", "r", "l", "s", "t", "nd", "rt", "ng", "ck", "ss", "ft"];

const ENDINGS: Readonly<Record<"de" | "en", readonly string[]>> = {
  de: ["", "", "", "e", "en", "er", "es", "s", "ung", "ungen"],
  en: ["", "", "", "s", "ed", "ing", "er", "ers", "ly"],
};

/** A vocabulary of `size` lemmas with Zipf weights and a sampler. */
export class Vocabulary {
  readonly lemmas: string[] = [];
  private readonly cdf: Float64Array;

  constructor(size: number, seed: number) {
    const r = rng(seed);
    const seen = new Set<string>();
    while (this.lemmas.length < size) {
      const syllables = 1 + Math.floor(r() * 3) + (r() < 0.3 ? 1 : 0);
      let w = "";
      for (let s = 0; s < syllables; s++) {
        w += ONSETS[Math.floor(r() * ONSETS.length)];
        w += VOWELS[Math.floor(r() * VOWELS.length)];
        w += CODAS[Math.floor(r() * CODAS.length)];
      }
      if (w.length < 3 || seen.has(w)) continue;
      seen.add(w);
      this.lemmas.push(w);
    }
    this.cdf = new Float64Array(size);
    let total = 0;
    for (let i = 0; i < size; i++) {
      total += 1 / (i + 1) ** 1.07;
      this.cdf[i] = total;
    }
    for (let i = 0; i < size; i++) this.cdf[i] = (this.cdf[i] as number) / total;
  }

  /** The rank of a sampled lemma. */
  sampleRank(r: () => number): number {
    const x = r();
    let lo = 0;
    let hi = this.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cdf[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** A sampled word with an inflection of `lang`. */
  word(r: () => number, lang: "de" | "en"): string {
    const lemma = this.lemmas[this.sampleRank(r)] as string;
    const endings = ENDINGS[lang];
    return lemma + (endings[Math.floor(r() * endings.length)] as string);
  }
}

function words(v: Vocabulary, r: () => number, lang: "de" | "en", n: number): string {
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = v.word(r, lang);
  return out.join(" ");
}

function logNormal(r: () => number, median: number, sigma: number): number {
  const u = Math.max(r(), 1e-9);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  return Math.round(median * Math.exp(sigma * z));
}

/** The benchmark collection: what site-search writes per page. */
export const BENCH_SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    sections: { kind: "passages" },
    anchors: { kind: "text" },
    shared: { kind: "text" },
    url: { kind: "keyword" },
    page_type: { kind: "keyword", facet: true },
  },
};

/** Slot weights the benchmark queries with (the plugin's starting defaults). */
export const BENCH_WEIGHTS = {
  title: 5,
  "sections.heading": 3,
  "sections.text": 1,
  anchors: 2,
  shared: 0.3,
} as const;

/** Options for {@link makeCorpus}. */
export interface CorpusOptions {
  readonly pages: number;
  readonly seed: number;
}

/** Shared module texts: CTAs and feature boxes placed on 11 to 49 pages each. */
function sharedBlocks(v: Vocabulary, seed: number): { de: string[]; en: string[] } {
  const r = rng(seed ^ 0x5eed);
  const make = (lang: "de" | "en") =>
    Array.from({ length: 400 }, () => words(v, r, lang, 15 + Math.floor(r() * 40)));
  return { de: make("de"), en: make("en") };
}

/** Generates page number `n`; 70 % English, 30 % German. Same number, seed and revision, same page. */
export function makeCorpus(
  v: Vocabulary,
  opts: CorpusOptions,
): (n: number, revision?: number) => CollectionDoc {
  const blocks = sharedBlocks(v, opts.seed);
  return (n, revision = 0) => {
    const r = rng(opts.seed * 7919 + n * 104729 + revision * 15485863);
    const lang: "de" | "en" = n % 10 < 7 ? "en" : "de";
    const bodyWords = Math.min(Math.max(logNormal(r, 550, 0.7), 60), 6000);
    const sectionCount = 1 + Math.floor(bodyWords / 200);
    const sections: Passage[] = [];
    let left = bodyWords;
    for (let i = 0; i < sectionCount; i++) {
      const size =
        i === sectionCount - 1 ? left : Math.max(20, Math.floor(bodyWords / sectionCount));
      left -= size;
      sections.push({
        anchor: `s${i}`,
        heading: words(v, r, lang, 2 + Math.floor(r() * 4)),
        text: words(v, r, lang, Math.max(size, 1)),
      });
    }
    const anchors = Array.from({ length: Math.floor(r() * 6) }, () =>
      words(v, r, lang, 1 + Math.floor(r() * 3)),
    ).join(" ");
    const shared = Array.from(
      { length: Math.floor(r() * 3) },
      () => blocks[lang][Math.floor(r() * blocks[lang].length)],
    ).join(" ");
    return {
      id: `page-${n}`,
      lang,
      values: {
        title: words(v, r, lang, 3 + Math.floor(r() * 6)),
        sections,
        anchors,
        shared,
        url: `/${lang}/p/${n}/`,
        page_type: ["article", "product", "doc", "news"][n % 4] as string,
      },
    };
  };
}

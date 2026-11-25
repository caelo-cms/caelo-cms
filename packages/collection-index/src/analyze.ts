// SPDX-License-Identifier: MPL-2.0

/**
 * Language analysis for the collection index (epic #1644, R2/R3).
 *
 * The same analyser runs when a segment is written (job) and when a query
 * is parsed (gateway), so a query term and an indexed term meet only when
 * both went through identical steps:
 *
 *   NFKC → word segmentation (Intl.Segmenter, so CJK and Thai work too)
 *   → locale lower case → diacritic folding (ä → a, ß → ss)
 *   → stopword removal → Snowball stem.
 *
 * Every word yields an exact term. In a language with a stemmer, a word
 * whose stem differs from it also yields a stem term (`~` prefix); a word
 * that is its own stem does not, because its exact term already is that
 * stem's posting list. The query side unites both (see `stemGroup`), so
 * "Preis" and "Preise" find each other without indexing every word twice.
 * Ranking weighs the exact term higher, so "Preis" ranks a page that says
 * "Preis" above one that only says "Preisen".
 *
 * German umlauts fold to their base letter (ä → a). A query typed without
 * an umlaut key ("uebersicht") also tries the folded spelling of ae/oe/ue
 * (`queryVariants`); the index holds no extra spelling. Protected terms
 * (brand and product names) skip stemming.
 *
 * Languages without a Snowball stemmer index exact forms only; that is a
 * property of the language set below, reported by `hasStemmer`.
 */

import { stemmer as danish } from "@orama/stemmers/danish";
import { stemmer as dutch } from "@orama/stemmers/dutch";
import { stemmer as english } from "@orama/stemmers/english";
import { stemmer as finnish } from "@orama/stemmers/finnish";
import { stemmer as french } from "@orama/stemmers/french";
import { stemmer as german } from "@orama/stemmers/german";
import { stemmer as greek } from "@orama/stemmers/greek";
import { stemmer as hungarian } from "@orama/stemmers/hungarian";
import { stemmer as italian } from "@orama/stemmers/italian";
import { stemmer as norwegian } from "@orama/stemmers/norwegian";
import { stemmer as portuguese } from "@orama/stemmers/portuguese";
import { stemmer as romanian } from "@orama/stemmers/romanian";
import { stemmer as russian } from "@orama/stemmers/russian";
import { stemmer as spanish } from "@orama/stemmers/spanish";
import { stemmer as swedish } from "@orama/stemmers/swedish";
import { stemmer as turkish } from "@orama/stemmers/turkish";

/** Prefix that marks a stem term in the dictionary. Sorts after every letter. */
export const STEM_PREFIX = "~";

const STEMMERS: Readonly<Record<string, (word: string) => string>> = {
  da: danish,
  de: german,
  el: greek,
  en: english,
  es: spanish,
  fi: finnish,
  fr: french,
  hu: hungarian,
  it: italian,
  nl: dutch,
  no: norwegian,
  pt: portuguese,
  ro: romanian,
  ru: russian,
  sv: swedish,
  tr: turkish,
};

/** Small, conservative stopword lists: only words that never carry meaning on their own. */
const STOPWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  de: new Set(
    "der die das den dem des ein eine einer eines einem einen und oder aber in im ins am an auf aus bei mit nach von vom zu zum zur für fur uber über unter vor ist sind war wird werden hat haben sich es er sie wir ihr ich du nicht auch als wie so dass daß wenn noch nur schon dann da hier dort was wer".split(
      " ",
    ),
  ),
  en: new Set(
    "the a an and or but in on at to of for from by with as is are was were be been it its this that these those there here which who what when where how not no yes do does did has have had i you he she we they them his her our your their".split(
      " ",
    ),
  ),
};

/**
 * One analysed word. `stem` is null when the language has no stemmer, or
 * the word is protected or holds a digit; otherwise it is set, also when it
 * equals `exact`.
 */
export interface Token {
  readonly exact: string;
  readonly stem: string | null;
  readonly position: number;
}

/** Options shared by indexing and querying. */
export interface AnalyzerOptions {
  /** Lower-cased, folded terms that are never stemmed. */
  readonly protectedTerms?: ReadonlySet<string>;
  /** Keep stopwords, for prefix completion where "die" may be the start of "dienst". */
  readonly keepStopwords?: boolean;
}

/** The primary language subtag, lower case ("de-CH" → "de"). */
export function primaryLanguage(lang: string): string {
  return lang.split("-")[0]?.toLowerCase() ?? lang.toLowerCase();
}

/** True when the language has a Snowball stemmer in this build. */
export function hasStemmer(lang: string): boolean {
  return primaryLanguage(lang) in STEMMERS;
}

/** Removes diacritics and maps ß to ss, after lower-casing. */
export function foldDiacritics(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ß/g, "ss");
}

/** The stem of an already folded word, or null when it is not stemmed (see {@link Token}). */
export function stemWord(
  exact: string,
  lang: string,
  options: AnalyzerOptions = {},
): string | null {
  const stem = STEMMERS[primaryLanguage(lang)];
  if (!stem || options.protectedTerms?.has(exact) || /\d/.test(exact)) return null;
  const s = stem(exact);
  return s.length > 0 ? s : null;
}

/**
 * Other folded spellings a query word may stand for. German: "ae", "oe",
 * "ue" typed for an umlaut ("uebersicht" → "ubersicht"). A wrong guess
 * ("steuer" → "steur") simply matches nothing.
 */
export function queryVariants(exact: string, lang: string): string[] {
  if (primaryLanguage(lang) !== "de" || !/ae|oe|ue/.test(exact)) return [];
  const folded = exact.replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
  return folded === exact ? [] : [folded];
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(lang: string): Intl.Segmenter {
  let seg = segmenters.get(lang);
  if (!seg) {
    seg = new Intl.Segmenter(lang, { granularity: "word" });
    segmenters.set(lang, seg);
  }
  return seg;
}

/** Splits text into analysed tokens for one language. */
export function analyze(text: string, lang: string, options: AnalyzerOptions = {}): Token[] {
  const primary = primaryLanguage(lang);
  const stopwords = options.keepStopwords ? undefined : STOPWORDS[primary];
  const tokens: Token[] = [];
  let position = 0;
  for (const part of segmenterFor(primary).segment(text.normalize("NFKC"))) {
    if (!part.isWordLike) continue;
    const exact = foldDiacritics(part.segment.toLocaleLowerCase(primary));
    if (exact.length > 0 && !stopwords?.has(exact))
      tokens.push({ exact, stem: stemWord(exact, primary, options), position });
    position++;
  }
  return tokens;
}

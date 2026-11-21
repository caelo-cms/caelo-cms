// SPDX-License-Identifier: MPL-2.0

/**
 * The search profile (issue #1651): the plugin's configuration and the
 * operator's lists turned into what the gateway's `search` and `suggest`
 * read. The plugin sets it at the end of every Stage; the release keeps
 * it, so a profile change goes live with Publish live like the index.
 *
 * Problems with a list entry (a pinned page that is no page of the site,
 * a synonym with one word) are not silently dropped: they come back as
 * `notes` for the index report and the AI.
 */

import type { SearchProfileInput } from "@caelo-cms/plugin-sdk";

/** One entry of a list as `lists.get` returns it. */
export interface ListEntry {
  readonly node: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** The lists the profile reads (empty when the config names none). */
export interface ProfileLists {
  readonly synonyms: readonly ListEntry[];
  readonly bestBets: readonly ListEntry[];
  readonly suggestions: readonly ListEntry[];
  readonly protectedTerms: readonly ListEntry[];
}

/** The configuration values the profile reads. */
export interface ProfileConfig {
  readonly reducedWeight: number;
  readonly titleWeight: number;
  readonly anchorWeight: number;
  readonly typos: boolean;
  readonly crossLanguage: boolean;
  readonly pageTypeWeights: Readonly<Record<string, number>>;
  readonly semantic: { readonly enabled: boolean; readonly weight: number };
}

const PAGE_REF = /^caelo:page\/([0-9a-f-]{36})(?:[?#].*)?$/;

/** The page id a link field names, or null for anything else. */
export function linkedPageId(value: unknown): string | null {
  const href =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "href" in value
        ? String((value as { href: unknown }).href)
        : "";
  return PAGE_REF.exec(href)?.[1] ?? null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A list entry's language: a language tag, or "*" for every language. */
function langOf(entry: ListEntry): string {
  const l = str(entry.values.lang).toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(l) ? (l.split("-")[0] as string) : "*";
}

/** Folds a word as the engine's synonym table keys it. */
function fold(word: string): string {
  return word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function add(table: Record<string, Record<string, string[]>>, lang: string, word: string, alts: string[]) {
  const forLang = (table[lang] ??= {});
  const key = fold(word);
  const merged = new Set([...(forLang[key] ?? []), ...alts.filter((a) => fold(a) !== key)]);
  if (merged.size > 0) forLang[key] = [...merged].slice(0, 10);
}

/** Languages a "*" entry applies to: every language the site's pages use. */
function expand(lang: string, siteLangs: readonly string[]): string[] {
  return lang === "*" ? [...siteLangs] : [lang];
}

export interface BuiltProfile {
  readonly profile: SearchProfileInput;
  readonly notes: readonly string[];
}

/** Builds the profile; `siteLangs` are the primary languages of the indexed pages. */
export function buildProfile(
  config: ProfileConfig,
  lists: ProfileLists,
  siteLangs: readonly string[],
  knownPages: ReadonlySet<string>,
): BuiltProfile {
  const notes: string[] = [];
  const langs = siteLangs.length > 0 ? siteLangs : ["de", "en"];
  const synonyms: Record<string, Record<string, string[]>> = {};
  for (const [i, e] of lists.synonyms.entries()) {
    const words = str(e.values.words)
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    if (words.length < 2) {
      notes.push(`synonym entry ${i + 1} ("${str(e.values.words)}") needs at least two words`);
      continue;
    }
    for (const lang of expand(langOf(e), langs)) {
      if (e.values.one_way === true) {
        add(synonyms, lang, words[0] as string, words.slice(1));
      } else {
        for (const w of words) add(synonyms, lang, w, words);
      }
    }
  }
  const bestBets: Record<string, { query: string; ids: string[] }[]> = {};
  for (const [i, e] of lists.bestBets.entries()) {
    const query = str(e.values.query);
    const pageId = linkedPageId(e.values.page);
    if (!query || !pageId) {
      notes.push(`pinned result ${i + 1} ("${query}") names no page of the site`);
      continue;
    }
    if (!knownPages.has(pageId)) {
      notes.push(`pinned result ${i + 1} ("${query}") names a page that is not in the search`);
      continue;
    }
    for (const lang of expand(langOf(e), langs)) {
      const list = (bestBets[lang] ??= []);
      const found = list.find((b) => fold(b.query) === fold(query));
      if (found) {
        if (!found.ids.includes(pageId) && found.ids.length < 5) found.ids.push(pageId);
      } else list.push({ query, ids: [pageId] });
    }
  }
  const suggestions: Record<string, { text: string; source: "curated" }[]> = {};
  for (const e of lists.suggestions) {
    const text = str(e.values.text);
    if (!text) continue;
    for (const lang of expand(langOf(e), langs)) {
      const list = (suggestions[lang] ??= []);
      if (list.length < 50) list.push({ text: text.slice(0, 120), source: "curated" });
    }
  }
  const protectedTerms = [
    ...new Set(lists.protectedTerms.map((e) => fold(str(e.values.word))).filter((w) => w.length > 0)),
  ].slice(0, 2000);
  const typeWeights = Object.entries(config.pageTypeWeights).filter(([, w]) => w !== 1);
  return {
    profile: {
      weights: {
        title: config.titleWeight,
        short_title: config.titleWeight,
        description: 1.2,
        breadcrumb: 0.5,
        "sections.heading": 2,
        "sections.text": 1,
        "reduced.heading": 2 * config.reducedWeight,
        "reduced.text": config.reducedWeight,
      },
      boosts:
        typeWeights.length > 0
          ? [{ field: "page_type", values: Object.fromEntries(typeWeights) }]
          : [],
      synonyms,
      bestBets,
      protectedTerms,
      typos: config.typos,
      compounds: true,
      prefix: true,
      crossLanguage: config.crossLanguage,
      semantic: config.semantic.enabled ? { weight: config.semantic.weight, minSimilarity: 0.3 } : null,
      suggestions,
    },
    notes,
  };
}

/** The configuration values the profile reads, from the stored configuration. */
export function profileConfigOf(values: Readonly<Record<string, unknown>>): ProfileConfig {
  const group = (name: string) => (values[name] ?? {}) as Record<string, unknown>;
  const counting = group("counting");
  const ranking = group("ranking");
  const semantic = group("semantic");
  return {
    reducedWeight: Number(counting.reduced_weight),
    titleWeight: Number(ranking.title_weight),
    anchorWeight: Number(ranking.anchor_weight),
    typos: ranking.typos === true,
    crossLanguage: ranking.cross_language === true,
    pageTypeWeights: (ranking.page_type_weights ?? {}) as Record<string, number>,
    semantic: { enabled: semantic.enabled === true, weight: Number(semantic.weight) },
  };
}

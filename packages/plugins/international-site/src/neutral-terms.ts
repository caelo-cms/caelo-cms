// SPDX-License-Identifier: MPL-2.0

/**
 * #1449 — text that is correct unchanged in another language: technical
 * terms ("Webhook", "Crawl"), and what is an address rather than language.
 *
 * The language checks compare a version's text with its source, and an
 * identical run reads as "not translated". The only way out was a glossary
 * entry with the word as its own translation, per word and per language.
 *
 * The list lives in the plugin's private storage beside the glossary, which
 * is the same kind of data: terminology the translation reads. It is not a
 * core list, because no module shows it and no other plugin may depend on
 * it (CLAUDE.md §2, plugin data zones).
 *
 * A text counts as neutral when nothing is left after taking out its
 * neutral terms and URL-shaped tokens, so "Alerts & Webhook" is neutral and
 * an untranslated sentence that happens to contain "Webhook" is not.
 */

import type { PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import type { GlossaryEntry } from "./translation.js";

/** `locale_code` of a term that is neutral in every language. */
export const EVERY_LANGUAGE = "*";

/** Most terms a site keeps. Every translation of a text using one reads it. */
export const MAX_NEUTRAL_TERMS = 1000;

/** What the translator is told about a neutral term. */
const NEUTRAL_CONTEXT = "language-neutral: keep exactly as written";

/** A `neutral_terms` row. */
export interface NeutralTermRow {
  readonly id: string;
  readonly term: string;
  /** A language code, or {@link EVERY_LANGUAGE}. */
  readonly locale_code: string;
}

/**
 * Tokens that address something instead of saying something: URLs, e-mail
 * addresses, site paths and file or host names (`robots.txt`, `example.com`).
 */
const URL_SHAPED = new RegExp(
  [
    "[a-z][a-z0-9+.-]*:\\/\\/\\S+",
    "(?:mailto|tel):\\S+",
    "www\\.\\S+",
    "[^\\s@]+@[^\\s@]+\\.[^\\s@]+",
    "(?<![\\p{L}\\p{N}\\/.])\\/[^\\s]*",
    "(?<![\\p{L}\\p{N}-])[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,10}(?![\\p{L}\\p{N}])",
  ].join("|"),
  "giu",
);

/** A term's whitespace as the page facts carry it: collapsed and trimmed. */
export function normalizeTerm(term: string): string {
  return term.replace(/\s+/g, " ").trim();
}

function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+");
}

/**
 * A matcher for whole occurrences of `terms`, any case, longest first so a
 * term inside a longer one does not split it. Null when there are none.
 */
export function neutralMatcher(terms: readonly string[]): RegExp | null {
  const usable = [...new Set(terms.map(normalizeTerm).filter((t) => t !== ""))];
  if (usable.length === 0) return null;
  const alternatives = usable
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp)
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Whether a text says something in a language: three letters remain once
 * its URL-shaped tokens and neutral terms are taken out. Below that a run
 * cannot be told apart between languages.
 *
 * @param neutral - from {@link neutralMatcher}
 */
export function hasLanguageText(text: string, neutral: RegExp | null): boolean {
  const addressesGone = text.replace(URL_SHAPED, " ");
  const rest = neutral === null ? addressesGone : addressesGone.replace(neutral, " ");
  return /\p{L}.*\p{L}.*\p{L}/u.test(rest);
}

/** The terms that hold for `localeCode`: its own and the every-language ones. */
export function termsFor(rows: readonly NeutralTermRow[], localeCode: string): string[] {
  return rows
    .filter((r) => r.locale_code === localeCode || r.locale_code === EVERY_LANGUAGE)
    .map((r) => r.term);
}

/**
 * The glossary a translation into `localeCode` is given: the language's
 * entries, plus each neutral term that occurs in `sourceText` as a term that
 * stays as it is. That keeps a large list out of every prompt, and it means
 * delegated translations (work items) read neutral terms the same way. An
 * entry the operator pinned for that language wins over a neutral term.
 */
export async function translationGlossary(
  q: PluginAdminQuery,
  localeCode: string,
  sourceText: string,
): Promise<GlossaryEntry[]> {
  const pinned = (await q.list("glossary", {
    locale_code: localeCode,
    limit: 500,
  })) as unknown as GlossaryEntry[];
  const glossary = pinned.map((g) => ({
    term: g.term,
    translation: g.translation,
    context: g.context,
  }));
  const taken = new Set(glossary.map((g) => g.term.toLowerCase()));
  const haystack = sourceText.toLowerCase();
  const neutral = (await q.list("neutral_terms", {
    anyOf: { locale_code: [localeCode, EVERY_LANGUAGE] },
    limit: MAX_NEUTRAL_TERMS,
  })) as unknown as NeutralTermRow[];
  for (const { term } of neutral) {
    const key = term.toLowerCase();
    if (taken.has(key) || !haystack.includes(key)) continue;
    taken.add(key);
    glossary.push({ term, translation: term, context: NEUTRAL_CONTEXT });
  }
  return glossary;
}

/** What a `set_neutral_terms` call changed, and the list it leaves. */
export interface NeutralTermsResult {
  readonly added: number;
  readonly removed: number;
  /** Every term of the scope asked about, with where it holds. */
  readonly terms: readonly { readonly term: string; readonly localeCode: string }[];
}

/**
 * Add and remove terms in one scope. A term already listed in the scope is
 * left alone, and removing one that is not listed changes nothing, so a
 * repeated call is harmless. With nothing to change it only reads.
 *
 * @param scope - a language code, or {@link EVERY_LANGUAGE}
 * @throws when the site would hold more than {@link MAX_NEUTRAL_TERMS}
 */
export async function setNeutralTerms(
  q: PluginAdminQuery,
  scope: string,
  add: readonly string[],
  remove: readonly string[],
): Promise<NeutralTermsResult> {
  const rows = (await q.list("neutral_terms", {
    limit: MAX_NEUTRAL_TERMS,
  })) as unknown as NeutralTermRow[];
  const inScope = new Map(
    rows.filter((r) => r.locale_code === scope).map((r) => [r.term.toLowerCase(), r]),
  );
  let removed = 0;
  for (const term of remove) {
    const row = inScope.get(normalizeTerm(term).toLowerCase());
    if (!row) continue;
    await q.delete("neutral_terms", row.id);
    inScope.delete(row.term.toLowerCase());
    removed += 1;
  }
  const fresh = new Map<string, string>();
  for (const raw of add) {
    const term = normalizeTerm(raw);
    if (term !== "" && !inScope.has(term.toLowerCase())) fresh.set(term.toLowerCase(), term);
  }
  const total = rows.length - removed + fresh.size;
  if (total > MAX_NEUTRAL_TERMS) {
    throw new Error(
      `set_neutral_terms: the site would hold ${total} neutral terms, the limit is ${MAX_NEUTRAL_TERMS}. Remove terms no page uses first; nothing was added.`,
    );
  }
  const added: NeutralTermRow[] = [];
  for (const term of fresh.values()) {
    const row = (await q.insert("neutral_terms", { term, locale_code: scope })) as { id: string };
    added.push({ id: row.id, term, locale_code: scope });
  }
  const kept = rows.filter(
    (r) => r.locale_code !== scope || inScope.get(r.term.toLowerCase())?.id === r.id,
  );
  return {
    added: added.length,
    removed,
    terms: [...kept, ...added].map((r) => ({ term: r.term, localeCode: r.locale_code })),
  };
}

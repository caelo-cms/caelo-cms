// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the check of one head-contribution answer against the closed
 * vocabulary (plugin SDK `head-contributions.ts`,
 * docs/dev/external-plugin-brokers.md §6.2), for every plugin, shipped or
 * installed (decision Q2 A). Pure: the caller resolves the page ids the
 * accepted entries name and renders them (head-composition.ts).
 *
 * Every part outside the vocabulary is refused with the rule it broke and
 * the rest of the answer stands: one bad entry does not take a page's
 * other alternates with it. A page with more than
 * {@link HEAD_ENTRIES_PER_PAGE} head entries (or sitemap alternates) gets
 * none of them, because a cut set would claim alternates the plugin did not
 * mean. An answer whose shape is not `{head?, sitemap?, lang?}` is refused
 * for every page it was asked about. A refusal is never silent: the caller
 * records it as a render failure.
 */

import {
  HEAD_ENTRIES_PER_PAGE,
  HEAD_META_PROPERTIES,
  type HeadEntry,
  headEntry,
  hreflangValue,
  type SitemapContribution,
  sitemapAlternate,
} from "@caelo-cms/plugin-sdk";
import { languageTagSchema } from "@caelo-cms/shared";

/** One refused part of an answer: the page, the part and the rule it broke. */
export interface HeadRefusal {
  readonly pageId: string;
  /** `link`, `meta`, `entry`, `entries`, `sitemap`, `lang` or `answer`. */
  readonly field: string;
  readonly rule: string;
}

/** What of one answer may reach the pages, and what was refused. */
export interface CheckedHeadAnswer {
  readonly head: ReadonlyMap<string, readonly HeadEntry[]>;
  readonly sitemap: ReadonlyMap<string, SitemapContribution>;
  readonly lang: ReadonlyMap<string, string>;
  readonly refusals: readonly HeadRefusal[];
}

/** The answer's own shape; its parts are checked one by one. */
interface RawAnswer {
  head?: unknown;
  sitemap?: unknown;
  lang?: unknown;
}

/**
 * What a plugin wrote, reduced to the characters a refusal marker may hold
 * (`plugin-value-refused:<plugin>.<point>.<field>:<rule>`), so the rule
 * names it: `rel-stylesheet`, `name-robots`, `property-og-image`.
 */
function token(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value !== "string") return "not-text";
  // Each run of other characters is one dash, so at most one dash leads or
  // trails; trimmed by hand, since `/-+$/` rescans every dash run of
  // plugin-supplied text and is quadratic.
  let t = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (t.startsWith("-")) t = t.slice(1);
  if (t.endsWith("-")) t = t.slice(0, -1);
  t = t.slice(0, 40);
  return t === "" ? "other" : t;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first key of `entry` outside `allowed`, or undefined. */
function extraKey(entry: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(entry).find((k) => !allowed.includes(k));
}

/** Why a link to another version (head `link` or sitemap alternate) is refused. */
function alternateRule(entry: Record<string, unknown>, allowed: readonly string[]): string {
  // A URL instead of a page: core builds every URL of the site itself.
  if ("href" in entry) return "href-not-allowed";
  const extra = extraKey(entry, allowed);
  if (extra !== undefined) return `attribute-${token(extra)}`;
  if (entry.hreflang === undefined) return "hreflang-missing";
  if (!hreflangValue.safeParse(entry.hreflang).success) return "hreflang-invalid";
  return "page-id-invalid";
}

/**
 * The part and the rule a head entry breaks. Called for an entry the
 * vocabulary's schema refused, so it always names a rule.
 */
export function headEntryRule(raw: unknown): { readonly field: string; readonly rule: string } {
  if (!isRecord(raw)) return { field: "entry", rule: "entry-shape" };
  if (raw.kind === "link") {
    if (raw.rel !== "alternate") return { field: "link", rule: `rel-${token(raw.rel)}` };
    return { field: "link", rule: alternateRule(raw, ["kind", "rel", "hreflang", "pageId"]) };
  }
  if (raw.kind === "meta") {
    if ("name" in raw) return { field: "meta", rule: `name-${token(raw.name)}` };
    if (!(HEAD_META_PROPERTIES as readonly unknown[]).includes(raw.property)) {
      return { field: "meta", rule: `property-${token(raw.property)}` };
    }
    const extra = extraKey(raw, ["kind", "property", "content"]);
    if (extra !== undefined) return { field: "meta", rule: `attribute-${token(extra)}` };
    return { field: "meta", rule: "content-format" };
  }
  return { field: "entry", rule: `kind-${token(raw.kind)}` };
}

/**
 * Check one plugin's answer for the pages it was asked about.
 *
 * @param asked the pages of this call; an answer for any other page is a
 *   plugin bug that would let it shadow another render, and throws.
 * @param label names the plugin and point in that error.
 */
export function checkHeadAnswer(
  raw: unknown,
  asked: ReadonlySet<string>,
  label: string,
): CheckedHeadAnswer {
  const head = new Map<string, HeadEntry[]>();
  const sitemap = new Map<string, SitemapContribution>();
  const lang = new Map<string, string>();
  const refusals: HeadRefusal[] = [];
  const refuse = (pageId: string, field: string, rule: string) =>
    refusals.push({ pageId, field, rule });

  const answer = isRecord(raw) ? (raw as RawAnswer) : null;
  const parts = answer === null ? [] : [answer.head, answer.sitemap, answer.lang];
  if (
    answer === null ||
    extraKey(answer as Record<string, unknown>, ["head", "sitemap", "lang"]) !== undefined ||
    parts.some((p) => p !== undefined && !isRecord(p))
  ) {
    for (const pageId of asked) refuse(pageId, "answer", "answer-shape");
    return { head, sitemap, lang, refusals };
  }
  const pagesOf = (part: unknown): [string, unknown][] => {
    const entries = Object.entries((part ?? {}) as Record<string, unknown>);
    for (const [pageId] of entries) {
      if (!asked.has(pageId)) {
        throw new Error(`${label}: answered for page ${pageId}, which is not part of this call`);
      }
    }
    return entries;
  };

  for (const [pageId, rawEntries] of pagesOf(answer.head)) {
    if (!Array.isArray(rawEntries)) {
      refuse(pageId, "entries", "entries-shape");
      continue;
    }
    if (rawEntries.length > HEAD_ENTRIES_PER_PAGE) {
      refuse(pageId, "entries", "entries-over-limit");
      continue;
    }
    const accepted: HeadEntry[] = [];
    for (const rawEntry of rawEntries) {
      const parsed = headEntry.safeParse(rawEntry);
      if (parsed.success) accepted.push(parsed.data);
      else {
        const { field, rule } = headEntryRule(rawEntry);
        refuse(pageId, field, rule);
      }
    }
    if (accepted.length > 0) head.set(pageId, accepted);
  }

  for (const [pageId, rawSitemap] of pagesOf(answer.sitemap)) {
    if (!isRecord(rawSitemap)) {
      refuse(pageId, "sitemap", "sitemap-shape");
      continue;
    }
    const extra = extraKey(rawSitemap, ["exclude", "alternates"]);
    if (extra !== undefined) {
      refuse(pageId, "sitemap", `attribute-${token(extra)}`);
      continue;
    }
    if (rawSitemap.exclude !== undefined && typeof rawSitemap.exclude !== "boolean") {
      refuse(pageId, "sitemap", "exclude-not-boolean");
      continue;
    }
    const rawAlternates = rawSitemap.alternates;
    if (rawAlternates !== undefined && !Array.isArray(rawAlternates)) {
      refuse(pageId, "sitemap", "alternates-shape");
      continue;
    }
    if ((rawAlternates?.length ?? 0) > HEAD_ENTRIES_PER_PAGE) {
      refuse(pageId, "sitemap", "alternates-over-limit");
      continue;
    }
    const alternates: { hreflang: string; pageId: string }[] = [];
    for (const rawAlternate of rawAlternates ?? []) {
      const parsed = sitemapAlternate.safeParse(rawAlternate);
      if (parsed.success) alternates.push(parsed.data);
      else {
        refuse(
          pageId,
          "sitemap",
          isRecord(rawAlternate)
            ? alternateRule(rawAlternate, ["hreflang", "pageId"])
            : "alternate-shape",
        );
      }
    }
    sitemap.set(pageId, {
      ...(rawSitemap.exclude === true ? { exclude: true } : {}),
      ...(alternates.length > 0 ? { alternates } : {}),
    });
  }

  for (const [pageId, rawLang] of pagesOf(answer.lang)) {
    const parsed = languageTagSchema.safeParse(rawLang);
    if (parsed.success) lang.set(pageId, parsed.data);
    else refuse(pageId, "lang", "lang-invalid");
  }
  return { head, sitemap, lang, refusals };
}

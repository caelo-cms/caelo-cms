// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import {
  EVERY_LANGUAGE,
  hasLanguageText,
  MAX_NEUTRAL_TERMS,
  neutralMatcher,
  setNeutralTerms,
  termsFor,
  translationGlossary,
} from "./neutral-terms.js";

/** The plugin store, as far as these helpers use it. */
function store(tables: Record<string, Record<string, unknown>[]> = {}): PluginAdminQuery {
  let next = 0;
  const rows = (table: string) => {
    tables[table] ??= [];
    return tables[table];
  };
  return {
    list: async (table: string, filter: Record<string, unknown> = {}) =>
      rows(table).filter((row) => {
        const anyOf = filter.anyOf as Record<string, string[]> | undefined;
        if (anyOf) {
          return Object.entries(anyOf).every(([c, vs]) => vs.includes(row[c] as string));
        }
        return filter.locale_code === undefined || row.locale_code === filter.locale_code;
      }),
    insert: async (table: string, values: Record<string, unknown>) => {
      next += 1;
      const row = { id: `r${next}`, ...values };
      rows(table).push(row);
      return row;
    },
    delete: async (table: string, id: string) => {
      tables[table] = rows(table).filter((row) => row.id !== id);
    },
  } as unknown as PluginAdminQuery;
}

describe("hasLanguageText", () => {
  const terms = neutralMatcher(["Webhook", "Crawl", "SEO Spider", "C++"]);

  it("treats text made of neutral terms as no language, in any case", () => {
    expect(hasLanguageText("Webhook", terms)).toBe(false);
    expect(hasLanguageText("WEBHOOK & crawl", terms)).toBe(false);
    expect(hasLanguageText("SEO   Spider", terms)).toBe(false);
    expect(hasLanguageText("C++", terms)).toBe(false);
  });

  it("keeps measuring a sentence that merely contains a neutral term", () => {
    expect(hasLanguageText("Lege einen Webhook an", terms)).toBe(true);
  });

  it("recognises a term that holds a URL shape", () => {
    expect(hasLanguageText("ASP.NET Core", neutralMatcher(["ASP.NET Core"]))).toBe(false);
  });

  it("matches whole words only", () => {
    expect(hasLanguageText("Webhooks", terms)).toBe(true);
    expect(hasLanguageText("Recrawl", terms)).toBe(true);
  });

  it("never measures URL-shaped tokens, with or without a list", () => {
    for (const text of [
      "https://example.com/preise",
      "mailto:info@example.com",
      "info@example.com",
      "/de/ratgeber/404-fehler",
      "robots.txt",
      "www.example.com",
      "example.com, sitemap.xml",
    ]) {
      expect(hasLanguageText(text, null)).toBe(false);
    }
  });

  it("measures the words around a URL, and does not read a slash in a word as a path", () => {
    expect(hasLanguageText("Mehr unter https://example.com/preise", null)).toBe(true);
    expect(hasLanguageText("und/oder", null)).toBe(true);
  });
});

describe("termsFor", () => {
  it("holds a term for its language and an every-language term for all", () => {
    const rows = [
      { id: "1", term: "Export", locale_code: "en" },
      { id: "2", term: "Webhook", locale_code: EVERY_LANGUAGE },
      { id: "3", term: "Alerts", locale_code: "fr" },
    ];
    expect(termsFor(rows, "en")).toEqual(["Export", "Webhook"]);
  });
});

describe("setNeutralTerms", () => {
  it("adds, ignores a term already listed in any case, and lists the result", async () => {
    const q = store();
    const first = await setNeutralTerms(q, EVERY_LANGUAGE, ["Webhook", " Page  Watch "], []);
    expect(first.added).toBe(2);
    const second = await setNeutralTerms(q, EVERY_LANGUAGE, ["webhook", "Crawl"], []);
    expect(second.added).toBe(1);
    expect(second.terms.map((t) => t.term)).toEqual(["Webhook", "Page Watch", "Crawl"]);
  });

  it("keeps scopes apart: a language's term does not stand in for every language", async () => {
    const q = store();
    await setNeutralTerms(q, "en", ["Export"], []);
    const r = await setNeutralTerms(q, EVERY_LANGUAGE, ["Export"], []);
    expect(r.added).toBe(1);
    expect(r.terms).toHaveLength(2);
  });

  it("removes in its scope only, and an unknown term changes nothing", async () => {
    const q = store();
    await setNeutralTerms(q, "en", ["Export"], []);
    await setNeutralTerms(q, EVERY_LANGUAGE, ["Export"], []);
    const r = await setNeutralTerms(q, "en", [], ["export", "Nope"]);
    expect(r.removed).toBe(1);
    expect(r.terms).toEqual([{ term: "Export", localeCode: EVERY_LANGUAGE }]);
  });

  it("reads when there is nothing to change", async () => {
    const q = store();
    await setNeutralTerms(q, "en", ["Export"], []);
    const r = await setNeutralTerms(q, EVERY_LANGUAGE, [], []);
    expect(r).toMatchObject({ added: 0, removed: 0 });
    expect(r.terms).toHaveLength(1);
  });

  it("refuses to pass the limit, writes nothing and says what to do", async () => {
    const full = Array.from({ length: MAX_NEUTRAL_TERMS }, (_, i) => ({
      id: `n${i}`,
      term: `t${i}`,
      locale_code: "en",
    }));
    const tables = { neutral_terms: full };
    await expect(setNeutralTerms(store(tables), "en", ["one more"], [])).rejects.toThrow(
      /Remove terms/,
    );
    expect(tables.neutral_terms).toHaveLength(MAX_NEUTRAL_TERMS);
  });

  it("changes nothing when the call as a whole would pass the limit", async () => {
    const full = Array.from({ length: MAX_NEUTRAL_TERMS }, (_, i) => ({
      id: `n${i}`,
      term: `t${i}`,
      locale_code: "en",
    }));
    const tables = { neutral_terms: full };
    await expect(setNeutralTerms(store(tables), "en", ["a", "b"], ["t0"])).rejects.toThrow(
      /nothing was changed/,
    );
    expect(tables.neutral_terms).toHaveLength(MAX_NEUTRAL_TERMS);
  });

  it("removes every copy two parallel chats left behind", async () => {
    const q = store({
      neutral_terms: [
        { id: "1", term: "Export", locale_code: "en" },
        { id: "2", term: "export", locale_code: "en" },
      ],
    });
    const r = await setNeutralTerms(q, "en", [], ["Export"]);
    expect(r).toMatchObject({ removed: 1, terms: [] });
  });
});

describe("translationGlossary", () => {
  it("adds the neutral terms the source uses as terms that stay as they are", async () => {
    const q = store({
      neutral_terms: [
        { id: "1", term: "Webhook", locale_code: EVERY_LANGUAGE },
        { id: "2", term: "Export", locale_code: "en" },
        { id: "3", term: "Alerts", locale_code: "fr" },
        { id: "4", term: "Crawl", locale_code: EVERY_LANGUAGE },
      ],
    });
    const glossary = await translationGlossary(q, "en", ["Der Webhook", "und der Export"]);
    expect(glossary.map((g) => g.term)).toEqual(["Webhook", "Export"]);
    expect(glossary[0]).toMatchObject({ translation: "Webhook" });
    expect(glossary[0]?.context).toContain("keep exactly as written");
  });

  it("lets a glossary entry of the language win over a neutral term", async () => {
    const q = store({
      glossary: [
        { id: "g", term: "Export", locale_code: "en", translation: "Download", context: null },
      ],
      neutral_terms: [{ id: "1", term: "export", locale_code: EVERY_LANGUAGE }],
    });
    const glossary = await translationGlossary(q, "en", ["Der Export"]);
    expect(glossary).toEqual([{ term: "Export", translation: "Download", context: null }]);
  });

  it("needs a whole word: a term inside another word is not used", async () => {
    const q = store({ neutral_terms: [{ id: "1", term: "API", locale_code: EVERY_LANGUAGE }] });
    expect(await translationGlossary(q, "en", ["Das Kapital"])).toEqual([]);
  });
});

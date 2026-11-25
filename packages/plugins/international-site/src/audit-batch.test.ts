// SPDX-License-Identifier: MPL-2.0

/**
 * #1632 — each call of `audit_findings` reads what its own rules need.
 *
 * The Stage audit calls the operation once for the site rules and once
 * per fact batch. Every batch call used to re-run the first call's
 * site-wide reads (`pages.list_shared_content` twice, every variant row),
 * so the check's cost grew with batches × site and a 299-page site ran
 * out of its 60 s. Here the batch call reads its pages' shared content
 * and the variant rows of the pages its facts name, and answers exactly
 * what the rules answer over the whole site's data (golden comparison).
 */

import { describe, expect, it } from "bun:test";
import { indexCheckedQuery, type PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import { auditFindings } from "./audit.js";
import { type AuditState, BuildModel, pageFindings } from "./audit-rules.js";
import type { ChromeDeps } from "./chrome-ops.js";
import plugin, { type LocaleRow, type PageVariantRow } from "./index.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HEADER = "11111111-1111-4111-8111-111111111111";
const BOX = "22222222-2222-4222-8222-222222222222";
const HOME_EN = id(1);
const HOME_DE = id(2);
const P1_EN = id(3);
const P1_DE = id(4);
const P2_EN = id(5);
const P2_DE = id(6);
const P3_EN = id(7);
const P3_DE = id(8);
const TEAM = id(9);
const BASE = "https://example.com";

const en: LocaleRow = {
  id: "l-en",
  code: "en",
  display_name: "English",
  url_strategy: "subdirectory",
  url_host: null,
  is_default: true,
};
const de: LocaleRow = { ...en, id: "l-de", code: "de", display_name: "Deutsch", is_default: false };
const locales = new Map([
  ["en", en],
  ["de", de],
]);

const variant = (
  n: number,
  pageId: string,
  group: string,
  locale: string,
  status: PageVariantRow["translation_status"],
): PageVariantRow & { id: string } => ({
  id: id(100 + n),
  group_id: group,
  page_id: pageId,
  locale_code: locale,
  translation_status: status,
});

const variants = [
  variant(1, HOME_EN, id(201), "en", "source"),
  variant(2, HOME_DE, id(201), "de", "up_to_date"),
  variant(3, P1_EN, id(202), "en", "source"),
  variant(4, P1_DE, id(202), "de", "up_to_date"),
  variant(5, P2_EN, id(203), "en", "source"),
  variant(6, P2_DE, id(203), "de", "up_to_date"),
  variant(7, P3_EN, id(204), "en", "source"),
  variant(8, P3_DE, id(204), "de", "up_to_date"),
];

const pathOf: Record<string, string> = {
  [HOME_EN]: "/",
  [HOME_DE]: "/de",
  [P1_EN]: "/p1",
  [P1_DE]: "/de/p1",
  [P2_EN]: "/p2",
  [P2_DE]: "/de/p2",
  [P3_EN]: "/p3",
  [P3_DE]: "/de/p3",
  [TEAM]: "/team",
};
const stagedPages = Object.entries(pathOf).map(([pageId, path]) => ({ pageId, path }));

/** Shared content: the header in the layout, the box synced on P2_EN only. */
const sharedOnPages: Record<string, string[]> = { [P2_EN]: [BOX] };

const link = (path: string, text: string, moduleId: string | null = null) => ({
  href: path,
  path,
  hreflang: null,
  text,
  moduleId,
  listItem: null,
  pluginSlug: null,
});
const text = (t: string, moduleId: string | null) => ({
  text: t,
  moduleId,
  listItem: null,
  pluginSlug: null,
  source: "text",
});

function pageFacts(pageId: string, lang: string, own: string): PluginAuditPageFacts {
  const path = pathOf[pageId] as string;
  return {
    pageId,
    path,
    lang,
    title: `${own} title`,
    metaDescription: `${own} description`,
    canonical: { href: `${BASE}${path}`, path },
    robots: null,
    ogLocale: null,
    ogLocaleAlternates: [],
    alternates: [
      { hreflang: "en", href: `${BASE}/p1`, path: "/p1" },
      { hreflang: "de", href: `${BASE}/de/p1`, path: "/de/p1" },
      { hreflang: "x-default", href: `${BASE}/p1`, path: "/p1" },
    ],
    sitemapAlternates: "no-sitemap",
    links: [
      link(lang === "en" ? "/" : "/de", lang === "en" ? "Home" : "Startseite", HEADER),
      // Into the other language's home: a language link, but to the home.
      link(lang === "en" ? "/de" : "/", lang === "en" ? "Deutsch" : "English", HEADER),
      // Into another group of the other language: P3 is outside the batch.
      link(lang === "en" ? "/de/p3" : "/p3", "Read more"),
      link("/team", "Team"),
    ],
    texts: [
      text("Menu", HEADER),
      // The box is synced on P2_EN only: here it is this page's own content.
      text("Box text that stays the same", BOX),
      text(own, null),
    ],
    truncated: false,
  };
}

const batch = [pageFacts(P1_EN, "en", "Our platform"), pageFacts(P1_DE, "de", "Unsere Plattform")];

interface Read {
  readonly op: string;
  readonly input: Record<string, unknown>;
}

/** Deps over the fixture: the store applies the host's index rule, core answers by scope. */
function depsOf(reads: Read[]): ChromeDeps {
  const tables: Record<string, readonly Record<string, unknown>[]> = { page_variants: variants };
  return {
    locales,
    listTypes: new Map(),
    q: indexCheckedQuery(plugin, "adminSchema", {
      list: async (table: string, filter: Record<string, unknown> = {}) => {
        reads.push({ op: `store:${table}`, input: filter });
        const anyOf = (filter.anyOf ?? {}) as Record<string, string[]>;
        const afterId = filter.afterId as string | undefined;
        return (tables[table] ?? []).filter(
          (r) =>
            Object.entries(anyOf).every(([col, vs]) => vs.includes(r[col] as string)) &&
            (afterId === undefined || (r.id as string) > afterId),
        );
      },
    }),
    cms: {
      call: async <O>(op: string, input: Record<string, unknown> = {}): Promise<O> => {
        reads.push({ op, input });
        if (op === "site_defaults.get") {
          return { defaults: { rootPageId: HOME_EN, notFoundPageId: null } } as O;
        }
        if (op === "lists.plugin_source_texts") return { sources: [] } as O;
        if (op === "pages.list_shared_content") {
          const on = input.onPageIds as string[] | undefined;
          const pagesOfBox = Object.keys(sharedOnPages).filter((p) => !on || on.includes(p));
          return {
            layoutPlacements: [
              {
                layoutId: "lay",
                layoutSlug: "site",
                blockName: "header",
                index: 0,
                moduleId: HEADER,
                moduleName: "Header",
                fields: [],
                values: {},
              },
            ],
            sharedInstances:
              pagesOfBox.length > 0
                ? [
                    {
                      contentInstanceId: "ci-box",
                      slug: null,
                      moduleId: BOX,
                      moduleName: "Box",
                      fields: [],
                      values: {},
                      pageIds: pagesOfBox,
                    },
                  ]
                : [],
            listInstances: [],
          } as O;
        }
        throw new Error(`a fact batch has no business reading ${op}`);
      },
    },
  } as unknown as ChromeDeps;
}

/** The whole site's data, as the rules see it with every row read. */
const wholeSite: AuditState = {
  locales,
  variants,
  stagedPages,
  siteHomePageId: HOME_EN,
  notFoundPageId: null,
  glossary: [],
  neutralTerms: [],
  sameOnPurpose: new Map(),
  chromeModuleIds: new Set([HEADER]),
  sharedModulesOn: new Map(Object.entries(sharedOnPages).map(([p, ms]) => [p, new Set(ms)])),
  staleChrome: [],
};

const sorted = (fs: readonly unknown[]) => fs.map((f) => JSON.stringify(f)).sort();

describe("#1632 — a fact batch reads what its pages name", () => {
  it("answers what the rules answer over the whole site's data", async () => {
    const reads: Read[] = [];
    const answer = await auditFindings(depsOf(reads), { pages: stagedPages, facts: batch });
    const expected = pageFindings(new BuildModel(wholeSite), batch);
    expect(sorted(answer.findings)).toEqual(sorted(expected));
    // The rules looked at P3's group, which is not in the batch.
    expect(answer.findings.map((f) => f.rule)).toContain("cross-locale-content-link");
    expect(answer.findings.map((f) => f.rule)).toContain("switcher-to-home");
  });

  it("asks core for the shared content of its pages only, and the store for named rows only", async () => {
    const reads: Read[] = [];
    await auditFindings(depsOf(reads), { pages: stagedPages, facts: batch });
    const shared = reads.filter((r) => r.op === "pages.list_shared_content");
    expect(shared.map((r) => r.input)).toEqual([{ onPageIds: [P1_EN, P1_DE] }]);
    const variantReads = reads.filter((r) => r.op === "store:page_variants");
    expect(variantReads.length).toBeGreaterThan(0);
    for (const r of variantReads) {
      expect(Object.keys((r.input.anyOf ?? {}) as object)).toHaveLength(1);
    }
  });

  it("a box synced on another page is this page's own text here, not shared content", async () => {
    const answer = await auditFindings(depsOf([]), { pages: stagedPages, facts: batch });
    const mixed = answer.findings.find(
      (f) => f.rule === "content-mixed-language" && f.pageId === P1_DE,
    );
    expect(mixed?.message).toContain(BOX);
    const chrome = answer.findings.filter((f) => f.rule === "chrome-untranslated");
    expect(chrome.map((f) => f.message.includes(HEADER))).toEqual([true]);
  });

  it("a model of some variant rows refuses to answer for a page it did not read", () => {
    const model = new BuildModel({
      ...wholeSite,
      variants: variants.filter((v) => v.group_id === id(202)),
      knownPages: new Set([P1_EN, P1_DE]),
    });
    expect(model.localeOf(P1_DE)).toBe("de");
    expect(() => model.localeOf(P3_DE)).toThrow(
      `page ${P3_DE}, which this fact batch did not load`,
    );
  });
});

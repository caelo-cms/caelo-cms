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

/** The audit run a batch call with its own pages reads the other pages by (#1721). */
const RUN = id(900);

/** What the first call reads beside the rules' sources, answered empty: its list findings. */
const FIRST_CALL_READS: Record<string, unknown> = {
  "list_types.list": { listTypes: [] },
  "lists.list": { lists: [] },
  "modules.list": { modules: [] },
  "pages.list": { pages: [] },
  "page_types.list": { pageTypes: [] },
};

/**
 * Deps over the fixture: the store applies the host's index rule, core
 * answers by scope. `site` is every page of the build (the staged pages
 * `quality_audits.staged_pages` answers from), `rows` the variant table.
 */
function depsOf(
  reads: Read[],
  site: readonly { pageId: string; path: string }[] = stagedPages,
  rows: readonly Record<string, unknown>[] = variants,
): ChromeDeps {
  const tables: Record<string, readonly Record<string, unknown>[]> = { page_variants: rows };
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
        if (op === "quality_audits.staged_pages") {
          expect(input.auditRunId).toBe(RUN);
          const ids = (input.pageIds ?? []) as string[];
          const paths = (input.paths ?? []) as string[];
          return {
            pages: site.filter((p) => ids.includes(p.pageId) || paths.includes(p.path)),
          } as O;
        }
        if (op in FIRST_CALL_READS) return FIRST_CALL_READS[op] as O;
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

/** The batch's pages, as core passes them on a batch call with its own pages only. */
const batchOwn = batch.map((f) => ({ pageId: f.pageId, path: f.path }));
const ownCall = { pages: batchOwn, facts: batch, batchPages: "own", auditRunId: RUN };

/**
 * A site `factor` times the fixture: the fixture's pages, and pages in
 * groups of their own the batch never names (each with a German version).
 */
function grown(factor: number): {
  site: { pageId: string; path: string }[];
  rows: (PageVariantRow & { id: string })[];
} {
  const site = [...stagedPages];
  const rows = [...variants];
  for (let i = 0; i < (factor - 1) * stagedPages.length; i += 2) {
    const en = id(10_000 + i);
    const de = id(10_001 + i);
    site.push({ pageId: en, path: `/x${i}` }, { pageId: de, path: `/de/x${i}` });
    rows.push(
      variant(1000 + i, en, id(20_000 + i), "en", "source"),
      variant(1001 + i, de, id(20_000 + i), "de", "up_to_date"),
    );
  }
  return { site, rows };
}

describe('#1721 — a batch call with its own pages (batchPages "own")', () => {
  it("answers exactly what the same batch with every page answers", async () => {
    const own = await auditFindings(depsOf([]), ownCall);
    const all = await auditFindings(depsOf([]), { pages: stagedPages, facts: batch });
    expect(sorted(own.findings)).toEqual(sorted(all.findings));
    expect(sorted(own.findings)).toEqual(sorted(pageFindings(new BuildModel(wholeSite), batch)));
    expect(own.findings.map((f) => f.rule)).toContain("cross-locale-content-link");
  });

  it("reads the pages its facts name by the audit run, the same on a site 500 times larger", async () => {
    const small: Read[] = [];
    const smallAnswer = await auditFindings(depsOf(small), ownCall);
    const big = grown(500);
    const large: Read[] = [];
    const largeAnswer = await auditFindings(depsOf(large, big.site, big.rows), ownCall);
    expect(sorted(largeAnswer.findings)).toEqual(sorted(smallAnswer.findings));
    expect(large).toEqual(small);
    const staged = small.filter((r) => r.op === "quality_audits.staged_pages");
    // One read: the named paths and the home. Every version of a named
    // page is named itself here, so no second read follows.
    expect(staged.map((r) => Object.keys(r.input).sort())).toEqual([
      ["auditRunId", "pageIds", "paths"],
    ]);
    expect(staged[0]?.input.pageIds).toEqual([HOME_EN]);
    expect([...((staged[0]?.input.paths ?? []) as string[])].sort()).toEqual(
      ["/", "/de", "/de/p3", "/p3", "/team"].sort(),
    );
    expect(small.filter((r) => r.op === "pages.list_shared_content").map((r) => r.input)).toEqual([
      { onPageIds: [P1_EN, P1_DE] },
    ]);
  });

  it("reads the versions of a linked page that no link names, by id", async () => {
    // Only the English page links into P3's group (to its German version):
    // the rules still ask for P3's English version, read in a second step.
    const oneWay = batch.map((f) =>
      f.pageId === P1_DE ? { ...f, links: f.links.filter((l) => l.path !== "/p3") } : f,
    );
    const reads: Read[] = [];
    const own = await auditFindings(depsOf(reads), { ...ownCall, facts: oneWay });
    const all = await auditFindings(depsOf([]), { pages: stagedPages, facts: oneWay });
    expect(sorted(own.findings)).toEqual(sorted(all.findings));
    const staged = reads.filter((r) => r.op === "quality_audits.staged_pages");
    expect(staged.map((r) => r.input.pageIds)).toEqual([[HOME_EN], [P3_EN]]);
  });

  it("the first call asks for batch calls with their own pages", async () => {
    const answer = await auditFindings(depsOf([]), { pages: stagedPages });
    expect(answer.factBatches?.length).toBeGreaterThan(0);
    expect(answer.batchPages).toBe("own");
  });

  it("a batch call with its own pages but no audit run fails loudly", async () => {
    await expect(
      auditFindings(depsOf([]), { pages: batchOwn, facts: batch, batchPages: "own" }),
    ).rejects.toThrow("carries no auditRunId");
  });

  it("a model of some pages refuses to answer for a path or page it did not read", () => {
    const model = new BuildModel({
      ...wholeSite,
      stagedPages: batchOwn,
      variants: variants.filter((v) => v.group_id === id(202)),
      knownPages: new Set([P1_EN, P1_DE]),
      knownPaths: new Set(["/p1", "/de/p1"]),
    });
    expect(model.pageAt.get("/de/p1")).toBe(P1_DE);
    expect(() => model.pageAt.get("/p2")).toThrow(
      "the path /p2, which this fact batch did not load",
    );
    expect(() => model.pathOf.has(P2_EN)).toThrow(`the page ${P2_EN}, which this fact batch`);
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type CollectionDocInput,
  configDefaults,
  indexCheckedQuery,
  manifestFromDefinition,
  type PageOutputFacts,
  type PageOutputModule,
  type PageOutputObserverArgs,
  parseConfigSchema,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import { SITE_SEARCH_CONFIG } from "./config.js";
import { anchorDocuments, normalizeAnchorText, pageDocument, sectionsOf } from "./documents.js";
import plugin from "./index.js";
import { aggregate, isPopularCandidate } from "./learn.js";

const observeOp = (ctx: unknown, a: PageOutputObserverArgs) =>
  (plugin.operations.observe as (c: unknown, x: unknown) => Promise<{ indexed: number }>)(ctx, a);

import { buildProfile, linkedPageId } from "./profile.js";
import { moduleWeighting, pageExclusion } from "./rules.js";

const COUNTING = { fullMax: 10, reducedMax: 49, chromeLinks: true };

const mod = (over: Partial<PageOutputModule>): PageOutputModule => ({
  moduleId: "m",
  name: "Block",
  kind: "content",
  zone: "page",
  contentInstanceId: null,
  placementCount: 1,
  ...over,
  contentPlacementCount: over.contentPlacementCount ?? over.placementCount ?? 1,
});

const text = (t: string, over: Partial<PageOutputFacts["texts"][number]> = {}) => ({
  text: t,
  moduleId: "m-body",
  listItem: null,
  pluginSlug: null,
  source: "text",
  heading: null,
  anchor: null,
  inForm: false,
  inLink: false,
  ...over,
});

function facts(over: Partial<PageOutputFacts> = {}): PageOutputFacts {
  return {
    pageId: "p-preise",
    url: "https://example.com/preise/",
    path: "/preise/",
    lang: "de",
    title: "Preise",
    shortTitle: null,
    metaDescription: "Was es kostet.",
    pageType: "product",
    properties: {},
    terms: { tags: ["t1"] },
    breadcrumb: ["Start", "Preise"],
    noindex: false,
    notFoundPage: false,
    hasDeferredContent: false,
    truncated: false,
    modules: [
      mod({ moduleId: "m-body", placementCount: 1 }),
      mod({ moduleId: "m-teaser", placementCount: 300 }),
      mod({ moduleId: "m-footer", zone: "layout", kind: "chrome", placementCount: 400 }),
    ],
    texts: [
      text("Pakete", { heading: 2, anchor: "pakete" }),
      text("Für Agenturen, monatlich kündbar.", { anchor: "pakete" }),
      text("Jetzt testen", { moduleId: "m-teaser" }),
      text("Impressum Datenschutz", { moduleId: "m-footer" }),
      text("E-Mail", { inForm: true }),
      text("Bewertungen", { pluginSlug: "ratings" }),
    ],
    links: [
      {
        href: "/kontakt/",
        path: "/kontakt/",
        targetPageId: "p-kontakt",
        text: "Kontakt",
        moduleId: "m-footer",
        zone: "layout",
        pluginSlug: null,
      },
      {
        href: "/blog/",
        path: "/blog/",
        targetPageId: "p-blog",
        text: "Unser Blog",
        moduleId: "m-body",
        zone: "page",
        pluginSlug: null,
      },
      {
        href: "https://x.org",
        path: null,
        targetPageId: null,
        text: "extern",
        moduleId: "m-body",
        zone: "page",
        pluginSlug: null,
      },
    ],
    outputHash: "h",
    ...over,
  };
}

describe("the manifest", () => {
  it("validates as a plugin manifest", () => {
    const r = pluginManifest.safeParse(manifestFromDefinition(plugin as never));
    if (!r.success) throw new Error(JSON.stringify(r.error.issues.slice(0, 5)));
    expect(r.data.collections?.pages?.fields.sections?.kind).toBe("passages");
  });
});

describe("what counts (rules)", () => {
  const w = (m: PageOutputModule, pageId = "p", settings?: Parameters<typeof moduleWeighting>[4]) =>
    moduleWeighting(m, pageId, 10_000, COUNTING, settings, undefined).weighting;
  it("a module on 5 pages counts fully, on 30 reduced, on 300 only on its home page", () => {
    expect(w(mod({ placementCount: 5 }))).toBe("full");
    expect(w(mod({ placementCount: 30 }))).toBe("reduced");
    expect(w(mod({ placementCount: 300 }))).toBe("none");
    expect(w(mod({ placementCount: 300 }), "home", { mode: "auto", homePage: "home" })).toBe(
      "full",
    );
  });
  it("more than half of a small site's pages is the last step from 11 pages on", () => {
    expect(
      moduleWeighting(mod({ placementCount: 12 }), "p", 20, COUNTING, undefined, undefined)
        .weighting,
    ).toBe("none");
    expect(
      moduleWeighting(mod({ placementCount: 10 }), "p", 15, COUNTING, undefined, undefined)
        .weighting,
    ).toBe("full");
  });
  it("chrome text counts only on its home page; templates always; explicit modes win", () => {
    expect(w(mod({ zone: "layout", placementCount: 3 }))).toBe("none");
    expect(w(mod({ zone: "layout" }), "contact", { mode: "auto", homePage: "contact" })).toBe(
      "full",
    );
    expect(w(mod({ zone: "template", placementCount: 5000 }))).toBe("full");
    expect(w(mod({ placementCount: 300 }), "p", { mode: "full", homePage: null })).toBe("full");
    expect(
      moduleWeighting(
        mod({ placementCount: 2, contentInstanceId: "ci" }),
        "p",
        10,
        COUNTING,
        { mode: "full", homePage: null },
        "never",
      ).weighting,
    ).toBe("none");
  });
  it("leaves out noindex, 404, the results page and excluded pages", () => {
    expect(pageExclusion(facts({ noindex: true }), { resultsPage: null, excluded: false })).toBe(
      "noindex",
    );
    expect(
      pageExclusion(facts({ notFoundPage: true }), { resultsPage: null, excluded: false }),
    ).toBe("not-found-page");
    expect(pageExclusion(facts(), { resultsPage: "p-preise", excluded: false })).toBe(
      "results-page",
    );
    expect(pageExclusion(facts(), { resultsPage: null, excluded: true })).toBe("excluded");
    expect(pageExclusion(facts(), { resultsPage: null, excluded: false })).toBeNull();
  });
});

describe("documents", () => {
  it("builds sections from counted text, never form fields, plugin regions or chrome", () => {
    const f = facts();
    const verdicts = new Map([
      ["m-body", { weighting: "full" as const, reason: "own" as const }],
      ["m-teaser", { weighting: "reduced" as const, reason: "few-pages" as const }],
      ["m-footer", { weighting: "none" as const, reason: "chrome" as const }],
    ]);
    const doc = pageDocument(f, verdicts);
    expect(doc.values.sections).toEqual([
      { anchor: "pakete", heading: "Pakete", text: "Für Agenturen, monatlich kündbar." },
    ]);
    expect(doc.values.reduced).toEqual([{ anchor: "", heading: "", text: "Jetzt testen" }]);
    expect(JSON.stringify(doc)).not.toContain("Impressum");
    expect(JSON.stringify(doc)).not.toContain("E-Mail");
    expect(JSON.stringify(doc)).not.toContain("Bewertungen");
    expect(doc.values.terms).toEqual(["tags:t1"]);
  });
  it("starts a section at every heading", () => {
    const f = facts({
      texts: [text("A", { heading: 2 }), text("one"), text("B", { heading: 2 }), text("two")],
    });
    expect(sectionsOf(f, () => true).map((s) => s.heading)).toEqual(["A", "B"]);
  });
  it("turns site links into anchor documents; navigation links once per block", () => {
    const docs = anchorDocuments(facts(), { chromeLinks: true, placementOf: () => 400 });
    expect(docs.map((d) => [d.values.source, d.values.target, d.values.sources]).sort()).toEqual([
      ["m:m-footer", "p-kontakt", 400],
      ["p:p-preise", "p-blog", 1],
    ]);
    expect(anchorDocuments(facts(), { chromeLinks: false, placementOf: () => 1 })).toHaveLength(1);
    expect(normalizeAnchorText("  Unser   Blog!  ")).toBe("unser blog");
  });
});

describe("the profile", () => {
  const config = {
    reducedWeight: 0.3,
    titleWeight: 3,
    anchorWeight: 1.5,
    typos: true,
    crossLanguage: false,
    pageTypeWeights: { product: 1.5 },
    semantic: { enabled: false, weight: 1 },
  };
  it("turns the lists into synonyms, pinned results, start questions and protected words", () => {
    const pageRef = "caelo:page/11111111-1111-4111-8111-111111111111";
    const r = buildProfile(
      config,
      {
        synonyms: [
          { node: "synonym", values: { words: "Kosten, Preise", lang: "de" } },
          {
            node: "synonym",
            values: { words: "seo, suchmaschinenoptimierung", one_way: true, lang: "de" },
          },
          { node: "synonym", values: { words: "allein" } },
        ],
        bestBets: [
          { node: "bet", values: { query: "Angebot", target_page: { href: pageRef }, lang: "de" } },
          { node: "bet", values: { query: "Angebot", target_page: { href: "https://x.org" } } },
        ],
        suggestions: [{ node: "suggestion", values: { text: "Was kostet es?", lang: "de" } }],
        protectedTerms: [{ node: "term", values: { word: "searchVIU" } }],
      },
      ["de"],
      { has: () => true },
    );
    expect(r.profile.synonyms?.de?.kosten).toEqual(["Preise"]);
    expect(r.profile.synonyms?.de?.preise).toEqual(["Kosten"]);
    expect(r.profile.synonyms?.de?.seo).toEqual(["suchmaschinenoptimierung"]);
    expect(r.profile.synonyms?.de?.suchmaschinenoptimierung).toBeUndefined();
    expect(r.profile.bestBets?.de).toEqual([
      { query: "Angebot", ids: ["11111111-1111-4111-8111-111111111111"] },
    ]);
    expect(r.profile.suggestions?.de).toEqual([{ text: "Was kostet es?", source: "curated" }]);
    expect(r.profile.protectedTerms).toEqual(["searchviu"]);
    expect(r.profile.boosts).toEqual([{ field: "page_type", values: { product: 1.5 } }]);
    expect(r.notes).toHaveLength(2);
    expect(linkedPageId({ href: `${pageRef}#x` })).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("counting visitors' searches", () => {
  it("calls a query popular after 5 searches on 3 days that found something", () => {
    const ev = (day: string, results = 3) =>
      ({
        kind: "search",
        text: "Preise",
        lang: "de",
        day,
        results,
        target: "",
        previous: "",
      }) as const;
    const { queries } = aggregate([
      ev("2026-11-01"),
      ev("2026-11-01"),
      ev("2026-11-02"),
      ev("2026-11-03"),
      ev("2026-11-03"),
    ]);
    expect(isPopularCandidate(queries[0] as never)).toBe(true);
    const few = aggregate([
      ev("2026-11-01"),
      ev("2026-11-01"),
      ev("2026-11-01"),
      ev("2026-11-01"),
      ev("2026-11-02"),
    ]);
    expect(isPopularCandidate(few.queries[0] as never)).toBe(false);
  });

  it("a search naming the query before it is a reformulation; a first search is none", () => {
    const search = (text: string, previous: string | null) =>
      ({
        kind: "search",
        text,
        lang: "de",
        day: "2026-11-01",
        results: 1,
        target: null,
        previous,
      }) as const;
    const { reformulations, queries } = aggregate([
      search("rabat", null),
      search("rabatte", "rabat"),
      search("Rabatte", "rabat"),
      search("rabatte", "rabatte"),
    ]);
    expect(reformulations).toEqual([{ from: "rabat", to: "rabatte", lang: "de", count: 2 }]);
    expect(queries.find((q) => q.text === "rabatte")?.searches).toBe(3);
  });
});

/** An in-memory stand-in for the host's handles, enough for the observer. */
function fakeCtx() {
  const collections = new Map<string, Map<string, CollectionDocInput>>();
  const calls: { op: string; collection: string; n: number }[] = [];
  const coll = (name: string) => {
    let c = collections.get(name);
    if (!c) {
      c = new Map();
      collections.set(name, c);
    }
    return c;
  };
  const handle = (name: string) => ({
    upsert: async (docs: readonly CollectionDocInput[]) => {
      calls.push({ op: "upsert", collection: name, n: docs.length });
      for (const d of docs) coll(name).set(d.id, d);
    },
    delete: async (ids: readonly string[]) => {
      calls.push({ op: "delete", collection: name, n: ids.length });
      for (const id of ids) coll(name).delete(id);
    },
    replace: async (
      field: string,
      values: readonly string[],
      docs: readonly CollectionDocInput[],
    ) => {
      calls.push({ op: "replace", collection: name, n: docs.length });
      for (const [id, d] of coll(name))
        if (values.includes(String(d.values[field]))) coll(name).delete(id);
      for (const d of docs) coll(name).set(d.id, d);
    },
    get: async (id: string) => coll(name).get(id) ?? null,
    getMany: async (ids: readonly string[]) => ({
      docs: new Map(
        ids.flatMap((id) =>
          coll(name).has(id) ? [[id, coll(name).get(id) as CollectionDocInput]] : [],
        ),
      ),
      pending: false,
    }),
    setProfile: async () => {},
    query: async () => ({ state: "none" as const, error: null, status: 503, body: null }),
  });
  const tables = new Map<string, Record<string, unknown>[]>();
  // The host's read rule in front of list() (#1536): a read no declared
  // index can drive fails here as it would in storage.
  const adminQuery = indexCheckedQuery(plugin, "adminSchema", {
    list: async (
      table: string,
      filter: { anyOf?: Record<string, unknown[]>; limit?: number } = {},
    ) =>
      (tables.get(table) ?? [])
        .filter((r) => Object.entries(filter.anyOf ?? {}).every(([k, vs]) => vs.includes(r[k])))
        .slice(0, filter.limit ?? 1000),
    insert: async (table: string, row: Record<string, unknown>) => {
      const id = crypto.randomUUID();
      tables.set(table, [...(tables.get(table) ?? []), { ...row, id }]);
      return { id };
    },
    update: async (table: string, id: string, patch: Record<string, unknown>) => {
      tables.set(
        table,
        (tables.get(table) ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
    },
  });
  const values = configDefaults(parseConfigSchema(SITE_SEARCH_CONFIG));
  const ctx = {
    config: {
      get: async () => values,
      entity: async () => ({}),
      entities: async (_k: string, ids: readonly string[]) => new Map(ids.map((id) => [id, {}])),
      configured: async () => [],
    },
    collections: { pages: handle("pages"), anchors: handle("anchors") },
    adminQuery,
    invocation: { origin: "observer", actorId: "system", stageRunId: "r" },
  };
  return { ctx, collections, calls, coll };
}

const args = (pages: PageOutputFacts[], final = false): PageOutputObserverArgs => ({
  runId: "r",
  pages,
  removed: [],
  placementChanges: [],
  final,
  publishedPageCount: 1000,
});

describe("the observer", () => {
  it("writes a page once, and nothing when it comes again unchanged — a footer edit included", async () => {
    const { ctx, calls, coll } = fakeCtx();
    await observeOp(ctx, args([facts()]));
    expect(coll("pages").size).toBe(1);
    expect(coll("anchors").size).toBe(2);
    calls.length = 0;
    // The footer's text changed (it does not count), its links did not.
    const footerEdited = facts({
      texts: facts().texts.map((t) =>
        t.moduleId === "m-footer" ? { ...t, text: "Impressum · AGB" } : t,
      ),
    });
    const r = await observeOp(ctx, args([footerEdited]));
    expect(r.indexed).toBe(0);
    expect(calls.filter((c) => c.op !== "replace" || c.n > 0)).toEqual([]);
  });

  it("rewrites the navigation block's anchor texts when its links change", async () => {
    const { ctx, calls, coll } = fakeCtx();
    await observeOp(ctx, args([facts()]));
    calls.length = 0;
    const renamed = facts({
      links: facts().links.map((l) =>
        l.moduleId === "m-footer" ? { ...l, text: "Kontakt & Anfahrt" } : l,
      ),
    });
    await observeOp(ctx, args([renamed]));
    expect(calls.some((c) => c.collection === "anchors" && c.op === "replace")).toBe(true);
    expect([...coll("anchors").values()].map((d) => d.values.text).sort()).toEqual([
      "Kontakt & Anfahrt",
      "Unser Blog",
    ]);
  });

  it("removes an excluded page's document but keeps its links as anchor texts", async () => {
    const { ctx, coll } = fakeCtx();
    await observeOp(ctx, args([facts()]));
    await observeOp(ctx, args([facts({ noindex: true })]));
    expect(coll("pages").size).toBe(0);
    expect(coll("anchors").size).toBe(2);
  });
});

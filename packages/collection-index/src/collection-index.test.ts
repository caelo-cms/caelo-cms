// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  analyze,
  applyChanges,
  ByteReader,
  ByteWriter,
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  compareTerms,
  editDistance,
  FileCache,
  fuse,
  highlight,
  idTerm,
  keywordTerm,
  layoutOf,
  lookupDocs,
  openRelease,
  prefetchRelease,
  queryVariants,
  type ReleaseManifest,
  releaseFiles,
  searchText,
  searchVectors,
  snippet,
  splitCompound,
  type TextQuery,
} from "./index.js";

const SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    sections: { kind: "passages", vector: true },
    url: { kind: "keyword" },
    page_type: { kind: "keyword", facet: true },
    published: { kind: "date" },
  },
};
const WORDS_ONLY: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    sections: { kind: "passages" },
    url: { kind: "keyword" },
    page_type: { kind: "keyword", facet: true },
    published: { kind: "date" },
  },
};
const WEIGHTS = { title: 5, "sections.heading": 3, "sections.text": 1 };

function page(
  id: string,
  lang: string,
  title: string,
  text: string,
  extra: Partial<Record<string, unknown>> = {},
): CollectionDoc {
  return {
    id,
    lang,
    values: {
      title,
      sections: [{ anchor: "intro", heading: (extra.heading as string) ?? "", text }],
      url: `/${id}/`,
      page_type: (extra.page_type as string) ?? "page",
      published: (extra.published as string) ?? "2026-01-01",
    },
  };
}

const DOCS: CollectionDoc[] = [
  page("preise", "de", "Preise", "Pakete für Agenturen, monatlich kündbar.", {
    page_type: "product",
  }),
  page("blog", "de", "Blog", "Ein Artikel über Preisen und Rabatte im Handel.", {
    page_type: "article",
    published: "2026-05-01",
  }),
  page(
    "logfile",
    "de",
    "Übersicht",
    "Die Logfile Analyse zeigt Crawler. Die Preisliste steht unten.",
    { heading: "Logfile Analyse" },
  ),
  page("pricing", "en", "Pricing", "Plans for agencies.", { page_type: "product" }),
  page(
    "logfile2",
    "de",
    "Logfile",
    "Mehr zur Logfile Analyse und Preis Modellen. Eine Liste der Crawler.",
    { page_type: "article" },
  ),
];

/** Tiny deterministic "embedding": a word-hash bag over 32 dims, enough to test the vector path. */
function fakeEmbed(texts: readonly string[]): Promise<Float32Array[]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Float32Array(32);
      for (const tk of analyze(t, "de")) {
        let h = 0;
        for (const c of tk.stem ?? tk.exact) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        v[h % 32] = (v[h % 32] as number) + 1;
        v[(h >>> 5) % 32] = (v[(h >>> 5) % 32] as number) - 0.5;
      }
      return v;
    }),
  );
}

function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const cache = () =>
    new FileCache(
      {
        read: async (f) => {
          const d = files.get(f);
          if (!d) throw new Error(`missing ${f}`);
          return d;
        },
      },
      1 << 26,
    );
  return { files, sink: (n: string, d: Uint8Array) => void files.set(n, d), cache };
}

async function build(
  docs: readonly CollectionDoc[],
  schema = WORDS_ONLY,
  previous: ReleaseManifest | null = null,
  store = memoryStore(),
  deletes: string[] = [],
  forceMerge = false,
) {
  const vector = layoutOf(schema).vectorFields.length > 0;
  const applied = await applyChanges(
    previous,
    { upserts: docs, deletes },
    {
      schema,
      sink: store.sink,
      cache: store.cache(),
      forceMerge,
      ...(vector ? { embed: fakeEmbed, vectorModel: { id: "fake-32", dims: 32 } } : {}),
    },
  );
  const release = await openRelease(applied.manifest, store.cache());
  return { applied, release, store };
}

function q(text: string, extra: Partial<TextQuery> = {}): TextQuery {
  return { text, lang: "de", weights: WEIGHTS, limit: 10, ...extra };
}

async function ids(
  release: Awaited<ReturnType<typeof build>>["release"],
  query: TextQuery,
): Promise<string[]> {
  const r = await searchText(release, query);
  const out: string[] = [];
  for (const h of r.hits) {
    for (const s of release.segments) {
      const d = (await s.reader.stored([h.key])).get(h.key);
      if (d && !s.removed.has(h.key)) out.push(d.id);
    }
  }
  return out;
}

describe("bytes and terms", () => {
  it("round-trips varints and strings", () => {
    const w = new ByteWriter(1);
    const values = [0, 1, 127, 128, 300, 2 ** 32, 2 ** 52];
    for (const n of values) w.uint(n);
    w.string("Übersicht");
    const r = new ByteReader(w.finish());
    expect(values.map(() => r.uint())).toEqual(values);
    expect(r.string()).toBe("Übersicht");
    expect(r.done).toBe(true);
  });

  it("orders terms by code point, the byte order of UTF-8", () => {
    expect(compareTerms("z�", "z\u{1F600}")).toBeLessThan(0);
    expect("z�" < "z\u{1F600}").toBe(false);
    expect(compareTerms("ab", "abc")).toBeLessThan(0);
  });
});

describe("analysis", () => {
  it("folds case and diacritics, drops stopwords and stems", () => {
    const t = analyze("Die Preisen der Übersicht", "de");
    expect(t.map((x) => x.exact)).toEqual(["preisen", "ubersicht"]);
    expect(t[0]?.stem).toBe("preis");
    expect(analyze("Preis", "de")[0]?.stem).toBe("preis");
    expect(queryVariants("uebersicht", "de")).toEqual(["ubersicht"]);
    expect(queryVariants("uebersicht", "en")).toEqual([]);
  });

  it("never stems protected terms or words with digits, and leaves languages without a stemmer unstemmed", () => {
    expect(
      analyze("searchviu 2026", "de", { protectedTerms: new Set(["searchviu"]) }).map(
        (x) => x.stem,
      ),
    ).toEqual([null, null]);
    expect(analyze("東京タワー", "ja").every((x) => x.stem === null)).toBe(true);
  });

  it("splits compounds only into words the site uses", () => {
    const df = (w: string) => ({ preis: 4, liste: 3, arbeit: 2, zeit: 5 })[w] ?? 0;
    expect(splitCompound("preisliste", df)).toEqual(["preis", "liste"]);
    expect(splitCompound("arbeitszeit", df)).toEqual(["arbeit", "zeit"]);
    expect(splitCompound("preisschild", df)).toBeNull();
    expect(splitCompound("preis", df)).toBeNull();
  });

  it("measures edits with transpositions", () => {
    expect(editDistance("pries", "preis", 2)).toBe(1);
    expect(editDistance("kosten", "kosten", 1)).toBe(0);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
  });

  it("refuses schemas no segment can hold", () => {
    expect(() => layoutOf({ fields: { id: { kind: "text" } } })).toThrow(/reserved/);
    expect(() => layoutOf({ fields: { url: { kind: "keyword" } } })).toThrow(/at least one text/);
    expect(() =>
      layoutOf({
        fields: Object.fromEntries(
          Array.from({ length: 8 }, (_v, i) => [`p${i}`, { kind: "passages" as const }]),
        ),
      }),
    ).toThrow(/at most 14/);
  });
});

describe("word search", () => {
  it("finds every inflection through the stem, ranks the title first and a compound part last", async () => {
    const { release } = await build(DOCS);
    expect(await ids(release, q("Preis"))).toEqual(["preise", "logfile2", "blog", "logfile"]);
  });

  it("ranks the exact form above another inflection in the same slot", async () => {
    const { release } = await build([
      page("a", "de", "", "Unsere Preisen"),
      page("b", "de", "", "Unsere Preise"),
    ]);
    expect(await ids(release, q("Preise"))).toEqual(["b", "a"]);
  });

  it("finds the folded spelling of a word typed without umlauts", async () => {
    const { release } = await build(DOCS);
    expect((await ids(release, q("Uebersicht")))[0]).toBe("logfile");
  });

  it("finds a compound through its parts, below the word itself", async () => {
    const { release } = await build(DOCS);
    expect(await ids(release, q("Liste"))).toEqual(["logfile2", "logfile"]);
  });

  it("never splits a compound into a word the site does not use on its own", async () => {
    const { release } = await build([
      page("a", "de", "", "Die Preisliste."),
      page("b", "de", "", "Ein Preis."),
    ]);
    expect(await ids(release, q("Liste"))).toEqual([]);
  });

  it("splits a typed compound against the site's vocabulary and reports it", async () => {
    const { release } = await build(DOCS);
    const r = await searchText(release, q("Logfileanalyse"));
    expect(r.splits).toEqual([{ from: "logfileanalyse", parts: ["logfile", "analyse"] }]);
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("corrects a typo to a vocabulary word and reports it", async () => {
    const { release } = await build(DOCS);
    const r = await searchText(release, q("Logfiel"));
    expect(r.corrections).toEqual([{ from: "logfiel", to: "logfile" }]);
    expect(r.hits.length).toBe(2);
    expect((await searchText(release, q("Logfiel", { typos: false }))).hits).toEqual([]);
  });

  it("expands visible synonyms", async () => {
    const { release } = await build(DOCS);
    expect(await ids(release, q("Kosten"))).toEqual([]);
    expect(
      (await ids(release, q("Kosten", { synonyms: new Map([["kosten", ["Preise"]]]) })))[0],
    ).toBe("preise");
  });

  it("completes the last word only from prefix slots", async () => {
    const { release } = await build(DOCS);
    expect((await ids(release, q("Prei", { prefix: true })))[0]).toBe("preise");
    expect(await ids(release, q("Rabat", { prefix: true }))).toEqual([]);
  });

  it("filters by language, keyword, exclusion and date range, and counts facets", async () => {
    const { release } = await build(DOCS);
    const all = await searchText(release, q("Logfile Preis", { facets: ["page_type"] }));
    expect(all.facets.page_type).toEqual([
      { value: "article", count: 2 },
      { value: "page", count: 1 },
      { value: "product", count: 1 },
    ]);
    expect(await ids(release, q("Pricing", { lang: "en", filter: { langs: ["de"] } }))).toEqual([]);
    expect(await ids(release, q("Pricing", { lang: "en", filter: { langs: ["en"] } }))).toEqual([
      "pricing",
    ]);
    expect(
      await ids(release, q("Preis", { filter: { keywords: { page_type: ["article"] } } })),
    ).toEqual(["logfile2", "blog"]);
    expect(
      await ids(
        release,
        q("Preis", { filter: { excludeKeywords: { page_type: ["article", "page"] } } }),
      ),
    ).toEqual(["preise"]);
    const may = Date.parse("2026-04-01");
    expect(
      await ids(release, q("Preis", { filter: { ranges: { published: { gte: may } } } })),
    ).toEqual(["blog"]);
  });

  it("fails loudly on a slot or field the collection does not have", async () => {
    const { release } = await build(DOCS);
    await expect(searchText(release, q("Preis", { weights: { body: 1 } }))).rejects.toThrow(
      /not a searchable slot/,
    );
    await expect(searchText(release, q("Preis", { facets: ["url_x"] }))).rejects.toThrow(
      /not a facet field/,
    );
  });

  it("looks documents up by id and by keyword value", async () => {
    const { release } = await build(DOCS);
    expect((await lookupDocs(release, [idTerm("blog")])).map((d) => d.id)).toEqual(["blog"]);
    expect((await lookupDocs(release, [keywordTerm("url", "/pricing/")])).map((d) => d.id)).toEqual(
      ["pricing"],
    );
  });
});

describe("chunked writing", () => {
  it("gives the same index whether documents are encoded in one chunk or one per chunk", async () => {
    const many = Array.from({ length: 60 }, (_v, i) =>
      page(
        `p${i}`,
        i % 3 === 0 ? "en" : "de",
        `Seite ${i} Preis`,
        `Text ${i} über Preise, Logfile Analyse und Kosten ${i % 7}.`,
      ),
    );
    const a = memoryStore();
    const b = memoryStore();
    const one = await applyChanges(
      null,
      { upserts: many, deletes: [] },
      { schema: WORDS_ONLY, sink: a.sink, cache: a.cache() },
    );
    const two = await applyChanges(
      null,
      { upserts: many, deletes: [] },
      { schema: WORDS_ONLY, sink: b.sink, cache: b.cache() },
    );
    expect(one.file).toBe(two.file);
    const { SegmentWriter } = await import("./writer.js");
    const files1 = new Map<string, Uint8Array>();
    const files2 = new Map<string, Uint8Array>();
    const w1 = new SegmentWriter({
      schema: WORDS_ONLY,
      sink: (n, d) => void files1.set(n, d),
      chunkDocs: 1,
    });
    const w2 = new SegmentWriter({
      schema: WORDS_ONLY,
      sink: (n, d) => void files2.set(n, d),
      chunkDocs: 10_000,
    });
    many.forEach((d, i) => {
      w1.add({ ...d, key: i + 1 });
      w2.add({ ...d, key: i + 1 });
    });
    expect(w1.finish().manifestFile).toBe(w2.finish().manifestFile);
  });
});

describe("releases", () => {
  it("updates a changed document in a delta segment and keeps its key", async () => {
    const first = await build(DOCS);
    const changed = page("blog", "de", "Blog", "Jetzt geht es um Versand.", {
      page_type: "article",
    });
    const second = await build([changed], WORDS_ONLY, first.applied.manifest, first.store);
    expect(second.applied.manifest.segments.length).toBe(2);
    expect(await ids(second.release, q("Rabatte"))).toEqual([]);
    expect(await ids(second.release, q("Versand"))).toEqual(["blog"]);
    expect(second.applied.manifest.docCount).toBe(DOCS.length);
    const blogKey = (await lookupDocs(first.release, [idTerm("blog")]))[0]?.key;
    expect((await lookupDocs(second.release, [idTerm("blog")]))[0]?.key).toBe(blogKey);
  });

  it("deletes a document from every segment", async () => {
    const first = await build(DOCS);
    const second = await build([], WORDS_ONLY, first.applied.manifest, first.store, ["pricing"]);
    expect(await ids(second.release, q("Pricing", { lang: "en" }))).toEqual([]);
    expect(second.applied.manifest.docCount).toBe(DOCS.length - 1);
  });

  it("writes data of size O(changes) for a delta", async () => {
    const many = Array.from({ length: 400 }, (_v, i) =>
      page(`p${i}`, "de", `Seite ${i}`, `Text ${i} mit vielen Worten über Thema ${i % 13}.`),
    );
    const first = await build(many);
    const second = await build(
      [page("p7", "de", "Seite 7", "Neu.")],
      WORDS_ONLY,
      first.applied.manifest,
      first.store,
    );
    expect(second.applied.bytesWritten).toBeLessThan(first.applied.bytesWritten / 20);
  });

  it("maintained equals rebuilt: a release after updates and deletes searches like one built from scratch", async () => {
    const store = memoryStore();
    let state = await build(DOCS, SCHEMA, null, store);
    const updates = [
      page("blog", "de", "Blog", "Versand in die Schweiz und Preise.", { page_type: "article" }),
      page("neu", "de", "Neu", "Eine neue Seite über Logfile Kosten."),
    ];
    state = await build(updates, SCHEMA, state.applied.manifest, store);
    state = await build([], SCHEMA, state.applied.manifest, store, ["pricing"]);
    const merged = await build([], SCHEMA, state.applied.manifest, store, [], true);
    expect(merged.applied.merged).toBe(true);
    expect(merged.applied.manifest.segments.length).toBe(1);
    const finalDocs = [...DOCS.filter((d) => d.id !== "pricing" && d.id !== "blog"), ...updates];
    const fresh = await build(finalDocs, SCHEMA);
    for (const text of ["Preis", "Logfile", "Versand", "Kosten", "Liste", "Rabatte"]) {
      expect(await ids(state.release, q(text))).toEqual(await ids(fresh.release, q(text)));
      expect(await ids(merged.release, q(text))).toEqual(await ids(fresh.release, q(text)));
    }
    const [vector] = await fakeEmbed(["Logfile Analyse"]);
    const sims = async (r: typeof fresh.release) =>
      (await searchVectors(r, { vector: vector as Float32Array, limit: 5, minSimilarity: -1 })).map(
        (h) => [h.key, h.passage, Math.round(h.similarity * 1e4)],
      );
    expect(await sims(merged.release)).toEqual(await sims(state.release));
  });

  it("lists every file a release needs, and nothing it does not", async () => {
    const first = await build(DOCS, SCHEMA);
    const files = await releaseFiles(first.applied.manifest, first.store.cache());
    files.add(first.applied.file);
    expect([...first.store.files.keys()].sort()).toEqual([...files].sort());
  });

  // The gateway's first search on searchVIU read about 130 files one by
  // one from object storage (#1745): opening a release now loads them.
  it("prefetches every file of a release, so a query after it reads nothing from the store", async () => {
    const store = memoryStore();
    let state = await build(DOCS, SCHEMA, null, store);
    state = await build(
      [page("neu", "de", "Neu", "Eine neue Seite über Logfile Kosten.")],
      SCHEMA,
      state.applied.manifest,
      store,
    );
    expect(state.applied.manifest.segments.length).toBe(2);
    let reads = 0;
    const cache = new FileCache(
      {
        read: async (f) => {
          reads++;
          return store.files.get(f) as Uint8Array;
        },
      },
      1 << 26,
    );
    const release = await openRelease(state.applied.manifest, cache);
    const report = await prefetchRelease(release, { parallel: 3 });
    // Every file but the segment manifests and removed sets (openRelease
    // read those) and the profile (none here).
    const all = await releaseFiles(state.applied.manifest, cache);
    const opened = state.applied.manifest.segments.flatMap((s) =>
      s.removed ? [s.manifest, s.removed] : [s.manifest],
    );
    expect(report).toEqual({
      files: all.size - opened.length,
      skipped: 0,
      failed: 0,
      firstError: null,
    });
    const before = reads;
    await ids(release, q("Logfile Kosten"));
    await ids(release, q("Preis", { typos: true }));
    const [vector] = await fakeEmbed(["Logfile Analyse"]);
    await searchVectors(release, { vector: vector as Float32Array, limit: 5, minSimilarity: -1 });
    expect(reads).toBe(before);
  });

  it("stops prefetching when told to, documents and term shards first", async () => {
    const store = memoryStore();
    const { applied } = await build(DOCS, SCHEMA, null, store);
    const order: string[] = [];
    const cache = new FileCache(
      {
        read: async (f) => {
          order.push(f);
          return store.files.get(f) as Uint8Array;
        },
      },
      1 << 26,
    );
    const release = await openRelease(applied.manifest, cache);
    order.length = 0;
    const seg = release.segments[0]?.reader.manifest;
    const firstTwo = 1 + (seg?.shards.length ?? 0);
    const report = await prefetchRelease(release, {
      parallel: 1,
      mayLoad: () => order.length < firstTwo,
    });
    expect(order).toEqual([seg?.docsFile, ...(seg?.shards ?? []).map((s) => s.file)]);
    expect(report.files).toBe(firstTwo);
    expect(report.skipped).toBeGreaterThan(0);
  });

  it("counts a file that cannot be read and loads the rest", async () => {
    const store = memoryStore();
    const { applied } = await build(DOCS, SCHEMA, null, store);
    const cache = new FileCache(
      {
        read: async (f) => {
          const d = store.files.get(f);
          if (!d || f.startsWith("s-")) throw new Error("store unavailable");
          return d;
        },
      },
      1 << 26,
    );
    const release = await openRelease(applied.manifest, cache);
    const report = await prefetchRelease(release);
    expect(report.failed).toBe(release.segments[0]?.reader.manifest.stores.length);
    expect(report.firstError).toMatch(/^s-.*: store unavailable$/);
    expect(report.files).toBeGreaterThan(0);
  });

  it("builds the same release from a stream as from a first batch of changes", async () => {
    const a = memoryStore();
    const b = memoryStore();
    const streamed = await buildRelease(
      (async function* () {
        yield* DOCS;
      })(),
      { schema: SCHEMA, sink: a.sink, embed: fakeEmbed, vectorModel: { id: "fake-32", dims: 32 } },
    );
    const batched = await applyChanges(
      null,
      { upserts: DOCS, deletes: [] },
      {
        schema: SCHEMA,
        sink: b.sink,
        cache: b.cache(),
        embed: fakeEmbed,
        vectorModel: { id: "fake-32", dims: 32 },
      },
    );
    expect(streamed.file).toBe(batched.file);
    await expect(
      buildRelease([DOCS[0] as CollectionDoc, DOCS[0] as CollectionDoc], {
        schema: WORDS_ONLY,
        sink: a.sink,
      }),
    ).rejects.toThrow(/appears twice/);
  });

  it("indexes a vector field without vectors while no model is set, and asks for a rebuild when one is", async () => {
    const store = memoryStore();
    const plain = await applyChanges(
      null,
      { upserts: DOCS, deletes: [] },
      { schema: SCHEMA, sink: store.sink, cache: store.cache() },
    );
    expect(plain.manifest.vectorModel).toBeNull();
    await expect(
      applyChanges(
        plain.manifest,
        { upserts: [], deletes: [] },
        {
          schema: SCHEMA,
          sink: store.sink,
          cache: store.cache(),
          embed: fakeEmbed,
          vectorModel: { id: "fake-32", dims: 32 },
        },
      ),
    ).rejects.toThrow(/another vector model/);
  });

  it("refuses a previous release built for another schema", async () => {
    const first = await build(DOCS);
    await expect(build([], SCHEMA, first.applied.manifest, first.store)).rejects.toThrow(
      /another schema/,
    );
  });
});

describe("vectors and fusion", () => {
  it("finds the passage nearest to the query vector and respects the similarity floor", async () => {
    const { release } = await build(DOCS, SCHEMA);
    const [vector] = await fakeEmbed(["Logfile Analyse Crawler"]);
    const hits = await searchVectors(release, {
      vector: vector as Float32Array,
      limit: 3,
      minSimilarity: 0.2,
    });
    expect(hits.length).toBeGreaterThan(0);
    const stored = await release.segments[0]?.reader.stored([hits[0]?.key as number]);
    expect(stored?.get(hits[0]?.key as number)?.id).toBe("logfile");
    expect(
      await searchVectors(release, {
        vector: vector as Float32Array,
        limit: 3,
        minSimilarity: 1.01,
      }),
    ).toEqual([]);
  });

  it("fuses rankings by reciprocal rank", () => {
    const fused = fuse(
      [
        { keys: [1, 2, 3], weight: 1 },
        { keys: [3, 1, 4], weight: 1 },
      ],
      3,
    );
    expect(fused.map((h) => h.key)).toEqual([1, 3, 2]);
  });
});

describe("snippets", () => {
  it("picks the matching passage and returns highlight ranges into the cut text", () => {
    const passages = [
      { anchor: "a", heading: "Start", text: "Nichts Wichtiges hier." },
      {
        anchor: "b",
        heading: "Preise",
        text: `${"Füllwort ".repeat(40)}Unsere Preise sind fair und die Preisliste ist kurz.`,
      },
    ];
    const s = snippet(passages, { exact: ["preise"], stems: ["preis"] }, "de", 80);
    expect(s?.anchor).toBe("b");
    const marked = (s?.text.highlights ?? []).map(([a, b]) => s?.text.text.slice(a, b));
    expect(marked).toContain("Preise");
    expect(s?.text.text.startsWith("… ")).toBe(true);
    expect(s?.heading.highlights).toEqual([[0, 6]]);
    expect(
      highlight("Übersicht der Preise", { exact: ["ubersicht"], stems: [] }, "de").highlights,
    ).toEqual([[0, 9]]);
  });
});

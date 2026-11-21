// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1649, #1651) — the shared executor of declared collection
 * operations, on real releases in memory. Every candidate source (words,
 * link texts, pinned results) honours the visitor's filters and language,
 * and when the sources are merged every page slices one fused order, so a
 * "more" click never repeats a hit.
 */

import { describe, expect, it } from "bun:test";
import {
  applyChanges,
  type CollectionDoc,
  type CollectionSchema,
  FileCache,
  openRelease,
} from "@caelo-cms/collection-index";
import { searchOperationManifest, searchProfile } from "@caelo-cms/plugin-sdk";
import { type OpenEntry, runCollectionOperation } from "./collection-query.js";

const PAGES: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    url: { kind: "keyword" },
    page_type: { kind: "keyword", facet: true },
  },
};
const ANCHORS: CollectionSchema = {
  fields: {
    text: { kind: "text" },
    target: { kind: "keyword" },
    sources: { kind: "number" },
  },
};

async function entry(
  docs: readonly CollectionDoc[],
  schema: CollectionSchema,
  profile: unknown,
): Promise<OpenEntry> {
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
  const applied = await applyChanges(
    null,
    { upserts: docs, deletes: [] },
    { schema, sink: (n, d) => void files.set(n, d), cache: cache() },
  );
  return {
    release: await openRelease(applied.manifest, cache()),
    profile: searchProfile.parse(profile),
  };
}

const BASE_PROFILE = {
  weights: { title: 1 },
  typos: false,
  compounds: false,
  prefix: false,
  crossLanguage: false,
  semantic: null,
};

const page = (id: string, title: string, type: string, lang = "de"): CollectionDoc => ({
  id,
  lang,
  values: { title, url: `/${id}/`, page_type: type },
});

const SEARCH = searchOperationManifest.parse({
  name: "search",
  kind: "search",
  collection: "pages",
  description: "The site's pages.",
  returns: ["url", "title", "page_type"],
  filters: ["page_type"],
  maxResults: 10,
  anchors: { collection: "anchors", target: "target", sources: "sources" },
});

const noEmbed = async (): Promise<Float32Array> => {
  throw new Error("no vectors in this test");
};

async function search(
  pages: OpenEntry,
  anchors: OpenEntry | null,
  query: Record<string, string>,
): Promise<{ hits: { url: string; pinned?: boolean }[]; more: boolean }> {
  const r = await runCollectionOperation(SEARCH, pages, "k", new URLSearchParams(query), {
    embedQuery: noEmbed,
    anchors,
  });
  expect(r.status).toBe(200);
  return r.body as { hits: { url: string; pinned?: boolean }[]; more: boolean };
}

describe("collection operations: every source honours the filter", () => {
  const docs = [
    page("blog-preise", "Preise im Vergleich", "article"),
    page("produkt-x", "Produkt X", "product"),
    page("produkt-en", "Product X", "product", "en"),
  ];

  it("a link text names a product, but an article filter keeps it out", async () => {
    const pages = await entry(docs, PAGES, BASE_PROFILE);
    const anchors = await entry(
      [{ id: "a1", lang: "de", values: { text: "Preise", target: "produkt-x", sources: 5 } }],
      ANCHORS,
      { ...BASE_PROFILE, weights: { text: 1 } },
    );
    const unfiltered = await search(pages, anchors, { q: "Preise", lang: "de" });
    expect(unfiltered.hits.map((h) => h.url)).toContain("/produkt-x/");
    const articles = await search(pages, anchors, {
      q: "Preise",
      lang: "de",
      "f.page_type": "article",
    });
    expect(articles.hits.map((h) => h.url)).toEqual(["/blog-preise/"]);
  });

  it("a pinned page outside the filter or the visitor's language is not shown", async () => {
    const pages = await entry(docs, PAGES, {
      ...BASE_PROFILE,
      bestBets: {
        de: [{ query: "preise", ids: ["produkt-en", "produkt-x"] }],
      },
    });
    const plain = await search(pages, null, { q: "Preise", lang: "de" });
    // The English page is pinned, but not in the visitor's language.
    expect(plain.hits.map((h) => [h.url, h.pinned === true])).toEqual([
      ["/produkt-x/", true],
      ["/blog-preise/", false],
    ]);
    const articles = await search(pages, null, {
      q: "Preise",
      lang: "de",
      "f.page_type": "article",
    });
    expect(articles.hits.map((h) => h.url)).toEqual(["/blog-preise/"]);
  });
});

describe("collection operations: a link to a page the index does not hold", () => {
  it("adds nothing: the page is offline, its link texts wait for it", async () => {
    const pages = await entry(
      [page("blog-preise", "Preise im Vergleich", "article")],
      PAGES,
      BASE_PROFILE,
    );
    const anchors = await entry(
      [{ id: "a1", lang: "de", values: { text: "Tarife", target: "offline", sources: 9 } }],
      ANCHORS,
      { ...BASE_PROFILE, weights: { text: 1 } },
    );
    const r = await search(pages, anchors, { q: "Tarife", lang: "de" });
    expect(r.hits).toEqual([]);
  });
});

describe("collection operations: boosts keep what link texts add", () => {
  it("a boost for a type none of the hits has leaves their order alone", async () => {
    // B matches the words better; many pages link A with the query, which
    // puts A first. A boost for another page type must not undo that.
    const docs = [
      page("a-tarif", "Tarif", "article"),
      page("b-tarif", "Tarif Tarif Tarif Übersicht", "article"),
    ];
    const anchors = await entry(
      [{ id: "l1", lang: "de", values: { text: "Tarif", target: "a-tarif", sources: 50 } }],
      ANCHORS,
      { ...BASE_PROFILE, weights: { text: 1 } },
    );
    const plain = await entry(docs, PAGES, BASE_PROFILE);
    const boosted = await entry(docs, PAGES, {
      ...BASE_PROFILE,
      boosts: [{ field: "page_type", values: { product: 2 } }],
    });
    const order = async (pages: OpenEntry) =>
      (await search(pages, anchors, { q: "Tarif", lang: "de" })).hits.map((h) => h.url);
    expect(await order(plain)).toEqual(["/a-tarif/", "/b-tarif/"]);
    expect(await order(boosted)).toEqual(["/a-tarif/", "/b-tarif/"]);
  });
});

describe("collection operations: pages of a merged order", () => {
  it("page 2 continues page 1 without a repeat, and says when the order ends", async () => {
    // 45 pages that all match, more than a window that grew with the page
    // would hold on page 1; a boost reorders them, which makes it a merge.
    const many = Array.from({ length: 45 }, (_, i) =>
      page(
        `p${String(i).padStart(2, "0")}`,
        `Angebot Nummer ${i}`,
        i % 3 === 0 ? "product" : "article",
      ),
    );
    const pages = await entry(many, PAGES, {
      ...BASE_PROFILE,
      boosts: [{ field: "page_type", values: { product: 2 } }],
    });
    const seen: string[] = [];
    for (let p = 1; p <= 5; p++) {
      const r = await search(pages, null, {
        q: "Angebot",
        lang: "de",
        limit: "10",
        page: String(p),
      });
      seen.push(...r.hits.map((h) => h.url));
      expect(r.more).toBe(p < 5);
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    // The boosted product pages come first.
    expect(seen.slice(0, 10).every((u) => Number(u.slice(2, 4)) % 3 === 0)).toBe(true);
  });
});

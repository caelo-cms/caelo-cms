// SPDX-License-Identifier: MPL-2.0

/**
 * Segment format 3 (#1780, #1781, #1783): an honest cache bound, store
 * blocks that decode only the documents asked for, keyword columns,
 * partitioned vectors for large segments, and a release of the format
 * before it that keeps answering until it is rebuilt.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyChanges,
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  columnValues,
  docPosition,
  FileCache,
  openRelease,
  parseRelease,
  RELEASE_FORMAT,
  releaseNeedsRebuild,
  searchText,
  searchVectors,
} from "./index.js";

function memory() {
  const files = new Map<string, Uint8Array>();
  let reads = 0;
  const source = {
    read: async (f: string) => {
      reads++;
      const d = files.get(f);
      if (!d) throw new Error(`missing ${f}`);
      return d;
    },
  };
  return {
    files,
    sink: (n: string, d: Uint8Array) => void files.set(n, d),
    cache: (budget = 1 << 28) => new FileCache(source, budget),
    reads: () => reads,
  };
}

const SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text" },
    target: { kind: "keyword" },
    sections: { kind: "passages", vector: true },
  },
};

/** Deterministic unit-ish vectors: `n` clusters, each passage near its cluster's direction. */
function clustered(texts: readonly string[], dims = 32): Float32Array[] {
  return texts.map((t) => {
    const m = /c(\d+)p(\d+)/.exec(t);
    const cluster = Number(m?.[1] ?? 0);
    const member = Number(m?.[2] ?? 0);
    const v = new Float32Array(dims);
    for (let j = 0; j < dims; j++) {
      const base = Math.sin((cluster + 1) * (j + 1) * 1.7);
      const noise = Math.sin((member + 3) * (j + 7) * 0.31 + cluster) * 0.35;
      v[j] = base + noise;
    }
    return v;
  });
}

function doc(i: number, clusters = 40): CollectionDoc {
  const c = i % clusters;
  return {
    id: `d${i}`,
    lang: "de",
    values: {
      title: `Seite ${i} Thema ${c}`,
      target: `/ziel/${i % 17}`,
      sections: [{ anchor: "a", heading: `Teil ${i}`, text: `c${c}p${i}` }],
    },
  };
}

describe("an honest cache bound (#1780)", () => {
  it("evicts by what the parsed values hold, not by the files' sizes", async () => {
    const files = new Map([
      ["a", new Uint8Array(10)],
      ["b", new Uint8Array(10)],
      ["c", new Uint8Array(10)],
    ]);
    const cache = new FileCache({ read: async (f) => files.get(f) as Uint8Array }, 1000);
    // Ten bytes on disk, four hundred in memory (deflated JSON parsed into objects).
    const fat = { parse: (d: Uint8Array) => d, bytes: () => 400 };
    await cache.get("a", fat);
    await cache.get("b", fat);
    expect(cache.bytesHeld).toBe(800);
    await cache.get("c", fat);
    expect(cache.bytesHeld).toBe(800);
    expect(cache.stats).toEqual({ hits: 0, misses: 3, bytesRead: 30, bytesLoaded: 1200 });
    await cache.get("a", fat);
    expect(cache.stats.misses).toBe(4);
  });

  it("counts what parsed files hold, so the heap follows the budget", async () => {
    const store = memory();
    const docs = Array.from({ length: 3000 }, (_v, i) => ({
      id: `p${i}`,
      lang: "de",
      values: {
        title: `Seite ${i} über ${["Preise", "Versand", "Logfile", "Crawler"][i % 4]}`,
        target: `/t/${i}`,
        sections: Array.from({ length: 4 }, (_s, k) => ({
          anchor: `s${k}`,
          heading: `Abschnitt ${k}`,
          text: `Ein längerer Text Nummer ${i}-${k} mit Wörtern wie Analyse, Bericht, Kosten, Übersicht und ${"Füllwort ".repeat(30)}`,
        })),
      },
    }));
    const built = await buildRelease(docs, {
      schema: SCHEMA,
      sink: store.sink,
      embed: async (t) => clustered(t),
      vectorModel: { id: "fake-32", dims: 32 },
      tuning: { packMaxBytes: 0 },
    });
    const cache = store.cache(1 << 40);
    const release = await openRelease(built.manifest, cache);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const kept: unknown[] = [];
    for (const s of release.segments) {
      kept.push(await s.reader.docs());
      for (let i = 0; i < s.reader.manifest.shards.length; i++)
        kept.push(await s.reader.termsWithPrefix(s.reader.manifest.shards[i]?.first ?? "", 1));
      kept.push(await s.reader.stored(Array.from({ length: 3000 }, (_v, k) => k + 1)));
    }
    Bun.gc(true);
    const grown = process.memoryUsage().heapUsed - before;
    // The decoded documents above are held by this test, not the cache: what
    // the cache holds is what it counts, within a third either way.
    const decoded =
      JSON.stringify(
        kept.at(-1) instanceof Map ? [...(kept.at(-1) as Map<number, unknown>).values()] : [],
      ).length * 2;
    const cached = grown - decoded;
    expect(cache.bytesHeld).toBeGreaterThan(0);
    expect(cached).toBeLessThan(cache.bytesHeld * 1.35 + 4_000_000);
    expect(cache.stats.bytesLoaded).toBeGreaterThanOrEqual(cache.stats.bytesRead * 0.9);
  }, 120_000);

  it("keeps store blocks compressed and decodes only the documents asked for", async () => {
    const store = memory();
    const built = await buildRelease(
      Array.from({ length: 200 }, (_v, i) => doc(i)),
      {
        schema: SCHEMA,
        sink: store.sink,
        embed: async (t) => clustered(t),
        vectorModel: { id: "fake-32", dims: 32 },
      },
    );
    const release = await openRelease(built.manifest, store.cache());
    const reader = release.segments[0]?.reader;
    const got = await reader?.stored([5, 150, 999]);
    expect([...(got?.keys() ?? [])].sort((a, b) => a - b)).toEqual([5, 150]);
    expect(got?.get(5)?.id).toBe("d4");
    let all = 0;
    for await (const _d of reader?.allStored() ?? []) all++;
    expect(all).toBe(200);
  });
});

describe("keyword columns (#1779)", () => {
  it("stores a keyword field per document in the docs file", async () => {
    const store = memory();
    const built = await buildRelease(
      Array.from({ length: 30 }, (_v, i) => doc(i)),
      {
        schema: SCHEMA,
        sink: store.sink,
        embed: async (t) => clustered(t),
        vectorModel: { id: "fake-32", dims: 32 },
        columns: ["target"],
      },
    );
    expect(built.manifest.columns).toEqual(["target"]);
    const release = await openRelease(built.manifest, store.cache());
    const docs = await release.segments[0]?.reader.docs();
    const column = docs?.columns.get("target");
    expect(column).toBeDefined();
    const at = docPosition(docs as NonNullable<typeof docs>, 20);
    expect(columnValues(column as NonNullable<typeof column>, at)).toEqual(["/ziel/2"]);
    expect(docPosition(docs as NonNullable<typeof docs>, 999)).toBe(-1);
  });

  it("refuses a column that is not a keyword field", async () => {
    await expect(
      buildRelease([doc(1)], {
        schema: SCHEMA,
        sink: () => {},
        embed: async (t) => clustered(t),
        vectorModel: { id: "fake-32", dims: 32 },
        columns: ["title"],
      }),
    ).rejects.toThrow('column "title" is not a keyword field');
  });

  it("asks for a rebuild when the columns change", () => {
    const m = { format: RELEASE_FORMAT, columns: ["target"] } as unknown as Parameters<
      typeof releaseNeedsRebuild
    >[0];
    expect(releaseNeedsRebuild(m, ["target"])).toBe(false);
    expect(releaseNeedsRebuild(m, [])).toBe(true);
  });
});

describe("partitioned vectors (#1783)", () => {
  const N = 2400;
  const tuning = { partitionMinVectors: 1000 };

  async function both() {
    const flatStore = memory();
    const partStore = memory();
    const docs = Array.from({ length: N }, (_v, i) => doc(i));
    const opts = {
      schema: SCHEMA,
      embed: async (t: readonly string[]) => clustered(t),
      vectorModel: { id: "fake-32", dims: 32 },
    };
    const flat = await buildRelease(docs, { ...opts, sink: flatStore.sink });
    const part = await buildRelease(docs, { ...opts, sink: partStore.sink, tuning });
    return {
      flat: await openRelease(flat.manifest, flatStore.cache()),
      part: await openRelease(part.manifest, partStore.cache()),
      partStore,
      partManifest: part.manifest,
    };
  }

  it("partitions a large segment, and finds what exhaustive int8 search finds", async () => {
    const { flat, part } = await both();
    const v = part.segments[0]?.reader.manifest.vectors;
    expect(v?.partitions?.lists.length).toBeGreaterThan(1);
    expect(v?.codes).toEqual([]);
    expect(flat.segments[0]?.reader.manifest.vectors?.partitions ?? null).toBeNull();
    const queries = clustered(
      Array.from({ length: 30 }, (_v, i) => `c${(i * 7) % 40}p${9000 + i}`),
    );
    let agree = 0;
    let total = 0;
    for (const q of queries) {
      const a = await searchVectors(flat, { vector: q, limit: 10, minSimilarity: -1, rescore: N });
      const b = await searchVectors(part, { vector: q, limit: 10, minSimilarity: -1 });
      const want = new Set(a.map((h) => h.key));
      agree += b.filter((h) => want.has(h.key)).length;
      total += a.length;
    }
    expect(agree / total).toBeGreaterThanOrEqual(0.95);
  });

  it("is deterministic: the same vectors give the same files", async () => {
    const a = await both();
    const b = await both();
    expect(a.partManifest.segments[0]?.manifest).toBe(b.partManifest.segments[0]?.manifest);
  });

  it("carries the stored vectors over in a merge, never re-embedding", async () => {
    const { part, partStore, partManifest } = await both();
    let embedded = 0;
    const merged = await applyChanges(
      partManifest,
      { upserts: [doc(5)], deletes: [] },
      {
        schema: SCHEMA,
        sink: partStore.sink,
        cache: partStore.cache(),
        embed: async (t) => {
          embedded += t.length;
          return clustered(t);
        },
        vectorModel: { id: "fake-32", dims: 32 },
        forceMerge: true,
        tuning,
      },
    );
    expect(embedded).toBe(0);
    const after = await openRelease(merged.manifest, partStore.cache());
    const q = clustered(["c3p9999"])[0] as Float32Array;
    const x = await searchVectors(part, { vector: q, limit: 5, minSimilarity: -1 });
    const y = await searchVectors(after, { vector: q, limit: 5, minSimilarity: -1 });
    expect(y.map((h) => h.key)).toEqual(x.map((h) => h.key));
  }, 60_000);
});

describe("a format-2 release (#1780)", () => {
  const dir = join(import.meta.dir, "__fixtures__/format2");
  const files = new Map(
    readdirSync(dir)
      .filter((f) => !f.endsWith(".ts"))
      .map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))]),
  );
  const releaseFile = [...files.keys()].find((f) => f.startsWith("release-")) as string;
  const manifest = parseRelease(files.get(releaseFile) as Uint8Array);
  const cache = () => new FileCache({ read: async (f) => files.get(f) as Uint8Array }, 1 << 26);

  it("keeps answering words, documents and vectors until it is rebuilt", async () => {
    expect(manifest.format).toBe(1);
    const release = await openRelease(manifest, cache());
    const r = await searchText(release, {
      text: "Preise",
      lang: "de",
      weights: { title: 2, "sections.text": 1 },
      limit: 5,
    });
    expect(r.hits.length).toBe(1);
    const stored = await release.segments[0]?.reader.stored(r.hits.map((h) => h.key));
    expect([...(stored?.values() ?? [])].map((d) => d.id)).toEqual(["preise"]);
    const near = await searchVectors(release, {
      vector: Float32Array.from({ length: 16 }, (_v, j) => j - 8),
      limit: 4,
      minSimilarity: -1,
    });
    expect(near.length).toBe(4);
  });

  it("is never extended: the next release is built from its documents", async () => {
    expect(releaseNeedsRebuild(manifest)).toBe(true);
    await expect(
      applyChanges(
        manifest,
        { upserts: [], deletes: ["kontakt"] },
        {
          schema: {
            fields: {
              title: { kind: "text" },
              url: { kind: "keyword" },
              sections: { kind: "passages", vector: true },
            },
          },
          sink: () => {},
          cache: cache(),
          embed: async (t) => t.map(() => new Float32Array(16)),
          vectorModel: { id: "fake-16", dims: 16 },
        },
      ),
    ).rejects.toThrow("older format");
  });
});

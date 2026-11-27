// SPDX-License-Identifier: MPL-2.0

/**
 * #1779, #1783 — the whole `search` operation's scale guard in PR CI: words,
 * link texts and vectors, as a site-search query runs on a cold gateway.
 * The engine's own guard (collection-index scale-guard.test.ts) measures
 * `searchText` alone; this one measures what the operation reads on top:
 * the link texts' targets and weights, the vector side and the documents
 * of the page shown.
 *
 * It counts what time cannot measure reliably on CI machines: the files
 * and bytes a cold query reads, and its rounds of reads (a round starts
 * when a read begins while none is in flight). Each round is one object
 * store latency on the critical path of a first search. The bounds are
 * about one and a half times what the operation reads today; a change that
 * needs more must say why in docs/dev/scale-gate.md.
 *
 * Measured 2026-11-27 on 4,000 pages, 12,000 link texts and 12,000
 * passages: before #1777, 92 files, 1.30 MB and 6 rounds per cold search;
 * now 32 files, 1.16 MB and 5 rounds with segments cut into files (a large
 * site), and 2 files in 1 round when each collection is one pack.
 */

import { describe, expect, it } from "bun:test";
import {
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  FileCache,
  openRelease,
  readQueryVectors,
} from "@caelo-cms/collection-index";
import { searchOperationManifest, searchProfile } from "@caelo-cms/plugin-sdk";
import { type OpenEntry, runCollectionOperation } from "./collection-query.js";

const PAGES = 4000;
const DIMS = 32;

const PAGE_SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    sections: { kind: "passages", vector: true },
    url: { kind: "keyword" },
    site_path: { kind: "keyword" },
    page_type: { kind: "keyword", facet: true },
  },
};
const ANCHOR_SCHEMA: CollectionSchema = {
  fields: {
    text: { kind: "text" },
    target: { kind: "keyword" },
    source: { kind: "keyword" },
    sources: { kind: "number" },
  },
};

const WORDS = Array.from({ length: 900 }, (_v, i) => `wort${i.toString(36)}x`);
const word = (n: number) => WORDS[(n * 7919) % WORDS.length] as string;
const vector = (t: string) =>
  Float32Array.from({ length: DIMS }, (_v, j) =>
    Math.sin((t.length + j) * (t.charCodeAt(j % t.length) % 13)),
  );

function page(n: number): CollectionDoc {
  return {
    id: `p${n}`,
    lang: "de",
    values: {
      title: `${word(n)} ${word(n + 1)} ${word(n * 3)}`,
      url: `/p/${n}/`,
      site_path: `/p/${n}/`,
      page_type: ["article", "product", "doc"][n % 3] as string,
      sections: Array.from({ length: 3 }, (_s, k) => ({
        anchor: `s${k}`,
        heading: word(n + k),
        text: Array.from({ length: 60 }, (_w, i) => word(n * 31 + k * 7 + i)).join(" "),
      })),
    },
  };
}

function anchor(n: number): CollectionDoc {
  return {
    id: `a${n}`,
    lang: "de",
    values: {
      text: `${word(n)} ${word(n + 2)}`,
      target: `/p/${(n * 13) % PAGES}/`,
      source: `p:${n % PAGES}`,
      sources: 1 + (n % 4),
    },
  };
}

/** Counts files, bytes and rounds of reads; each read takes a few milliseconds. */
class Counting {
  files = 0;
  bytes = 0;
  rounds = 0;
  private inFlight = 0;
  constructor(private readonly data: ReadonlyMap<string, Uint8Array>) {}
  read = async (name: string): Promise<Uint8Array> => {
    const d = this.data.get(name);
    if (!d) throw new Error(`no file ${name}`);
    if (this.inFlight === 0) this.rounds++;
    this.inFlight++;
    this.files++;
    this.bytes += d.length;
    await new Promise((r) => setTimeout(r, 3));
    this.inFlight--;
    return d;
  };
}

async function build(
  docs: () => Iterable<CollectionDoc>,
  schema: CollectionSchema,
  profile: unknown,
  extra: { columns?: string[]; vectors?: boolean; packs?: boolean } = {},
): Promise<{
  files: Map<string, Uint8Array>;
  manifest: Awaited<ReturnType<typeof buildRelease>>["manifest"];
}> {
  const files = new Map<string, Uint8Array>();
  const built = await buildRelease(docs(), {
    schema,
    sink: (n, d) => void files.set(n, d),
    profile,
    // Without packs, as a segment past PACK_MAX_BYTES is cut (a large site).
    ...(extra.packs === false ? { tuning: { packMaxBytes: 0 } } : {}),
    ...(extra.columns ? { columns: extra.columns } : {}),
    ...(extra.vectors
      ? {
          embed: async (t: readonly string[]) => t.map(vector),
          vectorModel: { id: "fake", dims: DIMS },
        }
      : {}),
  });
  return { files, manifest: built.manifest };
}

/** About one and a half times what the unpacked cold search reads today. */
const BOUNDS = { rounds: 7, files: 48, bytes: 1_800_000 };

const PROFILE = {
  weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
  boosts: [{ field: "page_type", values: { product: 1.5 } }],
  typos: true,
  compounds: true,
  prefix: false,
  crossLanguage: false,
  semantic: { weight: 1, minSimilarity: -1 },
};

async function coldSearches(
  packs: boolean,
): Promise<{ files: number; bytes: number; rounds: number }> {
  const pages = await build(
    function* () {
      for (let n = 1; n <= PAGES; n++) yield page(n);
    },
    PAGE_SCHEMA,
    PROFILE,
    { vectors: true, packs },
  );
  const anchors = await build(
    function* () {
      for (let n = 1; n <= PAGES * 3; n++) yield anchor(n);
    },
    ANCHOR_SCHEMA,
    { ...PROFILE, weights: { text: 1 }, boosts: [], semantic: null },
    { columns: ["target"], packs },
  );
  const op = searchOperationManifest.parse({
    name: "search",
    kind: "search",
    collection: "pages",
    description: "Pages.",
    returns: ["url", "title"],
    snippet: "sections",
    filters: ["page_type"],
    facets: ["page_type"],
    maxResults: 50,
    anchors: {
      collection: "anchors",
      target: "target",
      targetField: "site_path",
      sources: "sources",
    },
  });
  const read: { files: number; bytes: number; rounds: number }[] = [];
  for (let i = 0; i < 20; i++) {
    // A fresh cache per query: every query is a first one.
    const p = new Counting(pages.files);
    const a = new Counting(anchors.files);
    const pc = new FileCache({ read: p.read }, Number.POSITIVE_INFINITY);
    const ac = new FileCache({ read: a.read }, Number.POSITIVE_INFINITY);
    const entry: OpenEntry = {
      release: await openRelease(pages.manifest, pc),
      profile: searchProfile.parse(PROFILE),
      queryVectors: await readQueryVectors(pages.manifest, pc),
    };
    const anchorEntry: OpenEntry = {
      release: await openRelease(anchors.manifest, ac),
      profile: searchProfile.parse({
        ...PROFILE,
        weights: { text: 1 },
        boosts: [],
        semantic: null,
      }),
      queryVectors: new Map(),
    };
    const before = {
      files: p.files + a.files,
      bytes: p.bytes + a.bytes,
      rounds: Math.max(p.rounds, a.rounds),
    };
    const q = `${word(i * 17)} ${word(i * 17 + 1)}`;
    const r = await runCollectionOperation(op, entry, "k", new URLSearchParams({ q, lang: "de" }), {
      embedQuery: async (_f, text) => vector(text),
      anchors: anchorEntry,
    });
    expect(r.status).toBe(200);
    read.push({
      files: p.files + a.files - before.files,
      bytes: p.bytes + a.bytes - before.bytes,
      rounds: Math.max(p.rounds, a.rounds) - before.rounds,
    });
  }
  const worst = (k: "files" | "bytes" | "rounds") => Math.max(...read.map((x) => x[k]));
  return { files: worst("files"), bytes: worst("bytes"), rounds: worst("rounds") };
}

describe("the search operation's scale guard (#1779, #1783)", () => {
  it("a cold search of a small site reads one pack per collection, in one round", async () => {
    const r = await coldSearches(true);
    console.log(`[scale-guard] packed: ${r.files} files, ${r.bytes} bytes, ${r.rounds} rounds`);
    expect(r).toMatchObject({ files: 2, rounds: 1 });
  }, 180_000);

  it("a cold search of large segments reads a bounded number of files, bytes and rounds", async () => {
    const r = await coldSearches(false);
    console.log(`[scale-guard] unpacked: ${r.files} files, ${r.bytes} bytes, ${r.rounds} rounds`);
    expect(r.rounds).toBeLessThanOrEqual(BOUNDS.rounds);
    expect(r.files).toBeLessThanOrEqual(BOUNDS.files);
    expect(r.bytes).toBeLessThanOrEqual(BOUNDS.bytes);
  }, 180_000);
});

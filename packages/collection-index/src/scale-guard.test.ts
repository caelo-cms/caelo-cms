// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1652) — the collection engine's scale guard in PR CI.
 *
 * The full harness (`bench/run.ts`, 50,000 pages) measures time; CI
 * machines are too noisy for that. This guard measures what a cold query
 * READS, which a change to the engine moves deterministically: the files
 * and bytes one query loads from the store. Each file is one round trip to
 * the object store in the gateway (~30 ms), so a query that suddenly
 * loads every shard, or every stored-document file, fails here before it
 * reaches the 50k-page targets in docs/dev/scale-gate.md.
 *
 * The bounds are about twice what the engine reads today on this corpus;
 * a change that needs more must say why in that document.
 */

import { describe, expect, it } from "bun:test";
import { BENCH_SCHEMA, BENCH_WEIGHTS, makeCorpus, Vocabulary } from "../bench/corpus.js";
import { FileCache, type FileSource } from "./reader.js";
import { buildRelease, openRelease } from "./release.js";
import { searchText } from "./search.js";

const PAGES = 4000;
const SEED = 1644;
/** Distinct lemmas of the synthetic language (the bench uses 150,000 for 50k pages). */
const LEMMAS = 30_000;

/** Counts what a source hands out. */
class CountingSource implements FileSource {
  files = 0;
  bytes = 0;
  constructor(private readonly files_: ReadonlyMap<string, Uint8Array>) {}
  async read(name: string): Promise<Uint8Array> {
    const data = this.files_.get(name);
    if (!data) throw new Error(`no file ${name}`);
    this.files++;
    this.bytes += data.length;
    return data;
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

describe("collection engine scale guard (#1652)", () => {
  it("a cold query reads a bounded number of files and bytes", async () => {
    const vocab = new Vocabulary(LEMMAS, SEED);
    const page = makeCorpus(vocab, { pages: PAGES, seed: SEED });
    const files = new Map<string, Uint8Array>();
    const built = await buildRelease(
      (function* () {
        for (let n = 1; n <= PAGES; n++) yield page(n);
      })(),
      { schema: BENCH_SCHEMA, sink: (name, data) => void files.set(name, data) },
    );
    // Queries from the corpus's own titles: two words, as visitors type.
    const queries: string[] = [];
    for (let n = 7; queries.length < 60; n += 61) {
      const title = String(page(n).values.title).split(/\s+/);
      queries.push(title.slice(0, 2).join(" "));
    }
    const read: { files: number; bytes: number }[] = [];
    for (const q of queries) {
      const source = new CountingSource(files);
      const release = await openRelease(
        built.manifest,
        new FileCache(source, Number.POSITIVE_INFINITY),
      );
      const lang = /[äöüß]/.test(q) ? "de" : "en";
      await searchText(release, { text: q, lang, weights: BENCH_WEIGHTS, limit: 10, facets: [] });
      read.push({ files: source.files, bytes: source.bytes });
    }
    const p95Files = percentile(
      read.map((r) => r.files),
      95,
    );
    const p95Bytes = percentile(
      read.map((r) => r.bytes),
      95,
    );
    // Today: 9 files and 0.48 MB at p95 on 4,000 pages (18 / 2.2 MB at 50,000).
    expect(p95Files).toBeLessThanOrEqual(20);
    expect(p95Bytes).toBeLessThanOrEqual(1_000_000);
  }, 120_000);
});

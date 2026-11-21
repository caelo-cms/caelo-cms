// SPDX-License-Identifier: MPL-2.0

/**
 * Engine benchmark for plugin collections (#1652).
 *
 *   bun run packages/collection-index/bench/run.ts            # 50,000 pages
 *   BENCH_PAGES=5000 bun run packages/collection-index/bench/run.ts
 *
 * Measures, on one core: the full build (streamed to disk, peak heap), the
 * size of the files, warm and cold query latency, the memory of a fully
 * cached index, and the cost of a Stage's delta for 1, 100 and 1,000 changed
 * pages (what the indexing job writes and uploads) with query latency on the
 * resulting two-segment release. Cold queries run against a fresh cache,
 * once from local disk and once through a source that waits
 * `BENCH_STORE_LATENCY_MS` (default 30) per file, the first-byte time of an
 * object store read from the same region. Prints a markdown report;
 * `BENCH_OUT` also writes the JSON.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyChanges,
  buildRelease,
  FileCache,
  type FileSource,
  type OpenRelease,
  openRelease,
  type ReleaseManifest,
  searchText,
  snippet,
  type TextQuery,
} from "../src/index.js";
import { BENCH_SCHEMA, BENCH_WEIGHTS, makeCorpus, rng, Vocabulary } from "./corpus.js";

const PAGES = Number(process.env.BENCH_PAGES ?? 50_000);
const LEMMAS = Number(process.env.BENCH_LEMMAS ?? 150_000);
const STORE_LATENCY_MS = Number(process.env.BENCH_STORE_LATENCY_MS ?? 30);
const SEED = 1652;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ms = (n: number): string => `${n.toFixed(n < 10 ? 2 : 1)} ms`;

function percentiles(samples: number[]): { p50: number; p95: number; p99: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] as number };
}

class DiskSource implements FileSource {
  constructor(
    private readonly dir: string,
    private readonly latencyMs = 0,
  ) {}
  async read(file: string): Promise<Uint8Array> {
    if (this.latencyMs > 0) await Bun.sleep(this.latencyMs);
    return new Uint8Array(readFileSync(join(this.dir, file)));
  }
}

interface Query {
  readonly text: string;
  readonly lang: "de" | "en";
  readonly prefix: boolean;
}

/** Queries lean on the torso of the vocabulary: people search for words that tell pages apart. */
function makeQueries(v: Vocabulary, n: number): Query[] {
  const r = rng(SEED + 99);
  const out: Query[] = [];
  for (let i = 0; i < n; i++) {
    const lang: "de" | "en" = r() < 0.7 ? "en" : "de";
    const len = r() < 0.4 ? 1 : r() < 0.67 ? 2 : 3;
    const words: string[] = [];
    while (words.length < len) {
      const rank = v.sampleRank(r);
      if (rank < 30) continue;
      words.push(v.lemmas[rank] as string);
    }
    const prefix = i % 4 === 3;
    if (prefix) {
      const last = words[words.length - 1] as string;
      words[words.length - 1] = last.slice(0, Math.max(3, Math.ceil(last.length * 0.6)));
    }
    out.push({ text: words.join(" "), lang, prefix });
  }
  return out;
}

const query = (q: Query): TextQuery => ({
  text: q.text,
  lang: q.lang,
  weights: BENCH_WEIGHTS,
  limit: 10,
  prefix: q.prefix,
  facets: ["page_type"],
});

async function timeQueries(release: OpenRelease, queries: readonly Query[]): Promise<number[]> {
  const out: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    await searchText(release, query(q));
    out.push(performance.now() - t0);
  }
  return out;
}

/** One answer as the gateway would build it: hits, stored documents, snippets. */
async function answer(release: OpenRelease, q: Query): Promise<number> {
  const r = await searchText(release, query(q));
  let bytes = 0;
  for (const seg of release.segments) {
    const docs = await seg.reader.stored(r.hits.map((h) => h.key));
    for (const d of docs.values()) {
      const s = snippet((d.values.sections ?? []) as never, r.terms, d.lang);
      bytes += JSON.stringify({ url: d.values.url, title: d.values.title, s }).length;
    }
  }
  return bytes;
}

function dirBytes(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const f of readdirSync(dir)) {
    bytes += statSync(join(dir, f)).size;
    files++;
  }
  return { bytes, files };
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    pages: PAGES,
    lemmas: LEMMAS,
    bun: Bun.version,
    storeLatencyMs: STORE_LATENCY_MS,
  };
  const lines: string[] = [`# Collection index benchmark: ${PAGES.toLocaleString("en")} pages`, ""];
  // A fresh directory of its own (mkdtemp), never a predictable path.
  const root = mkdtempSync(join(tmpdir(), "caelo-collection-bench-"));
  const store = join(root, "store");
  mkdirSync(store, { recursive: true });
  const write = (name: string, data: Uint8Array): void => writeFileSync(join(store, name), data);

  const vocab = new Vocabulary(LEMMAS, SEED);
  const page = makeCorpus(vocab, { pages: PAGES, seed: SEED });

  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  let peakHeap = heapBefore;
  let samples = 0;
  const sample = (): void => {
    if (++samples % 64 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };
  let chars = 0;
  const t0 = performance.now();
  const built = await buildRelease(
    (function* () {
      for (let n = 1; n <= PAGES; n++) {
        const d = page(n);
        for (const s of d.values.sections as { text: string }[]) chars += s.text.length;
        sample();
        yield d;
      }
    })(),
    {
      schema: BENCH_SCHEMA,
      sink: (name, data) => {
        sample();
        write(name, data);
      },
    },
  );
  const buildMs = performance.now() - t0;
  const sizes = dirBytes(store);
  const cacheAll = (latency = 0) =>
    new FileCache(new DiskSource(store, latency), Number.POSITIVE_INFINITY);
  const base = await openRelease(built.manifest, cacheAll());
  const m = base.segments[0]?.reader.manifest;
  let shardBytes = 0;
  let largestShard = 0;
  for (const s of m?.shards ?? []) {
    shardBytes += s.bytes;
    largestShard = Math.max(largestShard, s.bytes);
  }
  report.build = {
    ms: buildMs,
    peakHeapGrowth: peakHeap - heapBefore,
    bytes: sizes.bytes,
    files: sizes.files,
    terms: m?.termCount,
    shards: m?.shards.length,
    shardBytes,
    largestShard,
    chars,
  };
  lines.push(
    "## Full build (streamed to disk, one core)",
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Build time | ${(buildMs / 1000).toFixed(1)} s (${Math.round(PAGES / (buildMs / 1000))} pages/s) |`,
    `| Peak heap growth | ${mb(peakHeap - heapBefore)} |`,
    `| Section text indexed | ${mb(chars)} |`,
    `| Distinct terms | ${(m?.termCount ?? 0).toLocaleString("en")} |`,
    `| Files | ${mb(sizes.bytes)} in ${sizes.files} files |`,
    `| Term shards | ${mb(shardBytes)} in ${m?.shards.length} shards, largest ${mb(largestShard)} |`,
    `| Stored documents (deflate, rebuild source) | ${m?.stores.length} files |`,
    "",
  );

  const queries = makeQueries(vocab, 2000);
  const plain = queries.filter((q) => !q.prefix);
  const typed = queries.filter((q) => q.prefix);

  // Warm: everything cached.
  {
    const cache = cacheAll();
    const release = await openRelease(built.manifest, cache);
    Bun.gc(true);
    const heap0 = process.memoryUsage().heapUsed;
    await timeQueries(release, queries);
    for (const s of release.segments[0]?.reader.manifest.shards ?? [])
      await release.segments[0]?.reader.termsWithPrefix(s.first, 1);
    Bun.gc(true);
    const heapFull = process.memoryUsage().heapUsed - heap0;
    const warm = percentiles(await timeQueries(release, plain));
    const warmPrefix = percentiles(await timeQueries(release, typed));
    const bytes = percentiles(
      await Promise.all(plain.slice(0, 200).map((q) => answer(release, q))),
    );
    report.warm = {
      plain: warm,
      prefix: warmPrefix,
      heapFullyCached: heapFull,
      answerBytes: bytes,
    };
    lines.push(
      "## Warm queries (whole index cached, one core, with facet counts)",
      "",
      "| Query | p50 | p95 | p99 | max |",
      "|---|---|---|---|---|",
      `| Words (${plain.length}) | ${ms(warm.p50)} | ${ms(warm.p95)} | ${ms(warm.p99)} | ${ms(warm.max)} |`,
      `| Search as you type (${typed.length}) | ${ms(warmPrefix.p50)} | ${ms(warmPrefix.p95)} | ${ms(warmPrefix.p99)} | ${ms(warmPrefix.max)} |`,
      "",
      `Heap of the fully cached index: ${mb(heapFull)}. Answer of 10 hits with snippets, before compression: p50 ${(bytes.p50 / 1024).toFixed(1)} KB, p95 ${(bytes.p95 / 1024).toFixed(1)} KB.`,
      "",
    );
  }

  // Cold: a fresh cache per query, including stored documents and snippets.
  for (const [label, latency] of [
    ["local disk", 0],
    [`object store (${STORE_LATENCY_MS} ms per file)`, STORE_LATENCY_MS],
  ] as const) {
    const lat: number[] = [];
    const files: number[] = [];
    const bytes: number[] = [];
    for (const q of plain.filter((_q, i) => i % 10 === 0).slice(0, 120)) {
      const cache = new FileCache(new DiskSource(store, latency), 256 * 1024 * 1024);
      const t = performance.now();
      const release = await openRelease(built.manifest, cache);
      await answer(release, q);
      lat.push(performance.now() - t);
      files.push(cache.stats.misses);
      bytes.push(cache.stats.bytesLoaded);
    }
    const p = percentiles(lat);
    const f = percentiles(files);
    const by = percentiles(bytes);
    report.cold ??= {};
    (report.cold as Record<string, unknown>)[label] = { latency: p, files: f, bytes: by };
    lines.push(
      `## Cold answer, ${label}`,
      "",
      `p50 ${ms(p.p50)}, p95 ${ms(p.p95)}, max ${ms(p.max)}; files read p50 ${f.p50}, p95 ${f.p95}; bytes read p50 ${mb(by.p50)}, p95 ${mb(by.p95)}.`,
      "",
    );
  }

  // Deltas: what the indexing job writes after a Stage with 1, 100 and 1,000 changed pages.
  lines.push(
    "## Delta per Stage",
    "",
    "| Changed pages | Index time | Written | Warm p50 / p95 on base + delta |",
    "|---|---|---|---|",
  );
  const deltas: unknown[] = [];
  for (const changed of [1, 100, 1000]) {
    const r = rng(SEED + changed);
    const nums = new Set<number>();
    while (nums.size < changed) nums.add(1 + Math.floor(r() * PAGES));
    const t = performance.now();
    const applied = await applyChanges(
      built.manifest as ReleaseManifest,
      { upserts: [...nums].map((n) => page(n, 1)), deletes: [] },
      { schema: BENCH_SCHEMA, sink: write, cache: cacheAll() },
    );
    const indexMs = performance.now() - t;
    const release = await openRelease(applied.manifest, cacheAll());
    await timeQueries(release, plain.slice(0, 600));
    const p = percentiles(await timeQueries(release, plain.slice(0, 600)));
    deltas.push({ changed, ms: indexMs, bytesWritten: applied.bytesWritten, warm: p });
    lines.push(
      `| ${changed} | ${ms(indexMs)} | ${mb(applied.bytesWritten)} | ${ms(p.p50)} / ${ms(p.p95)} |`,
    );
  }
  report.deltas = deltas;
  lines.push(
    "",
    "Unchanged files keep their names, so an upload or a Publish live copy moves only what a delta wrote.",
    "",
  );

  rmSync(root, { recursive: true, force: true });
  console.log(lines.join("\n"));
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));
}

await main();

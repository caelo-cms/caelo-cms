// SPDX-License-Identifier: MPL-2.0

/**
 * Vector recall at scale (#1783): how many of the exhaustive int8 search's
 * top 10 documents the flat path (binary candidates, `rescore` rescored)
 * and the partitioned path (`probe` lists) find, on real model vectors.
 *
 *   bun run packages/collection-index/bench/partitions.ts <set> [options]
 *
 *   <set>   "synthetic" (the bench corpus's sections, BENCH_PASSAGES of them)
 *           or "real" (every paragraph of the repository's Markdown, plus
 *           `--texts <file>`, one passage per line)
 *   --cache <dir>   keeps the embedded vectors there (re-runs skip the model)
 *
 * Vectors come from the catalog's default model on native ONNX Runtime
 * (CAELO_MODELS_DIR), one text per run as the index job embeds. Queries
 * are 200 held-out passages, embedded as queries are; the truth is the
 * exhaustive int8 ranking over every passage (`rescore` = all). Prints a
 * Markdown table for docs/dev/scale-gate.md.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EMBEDDING_MODEL_ID, embeddingModel } from "@caelo-cms/shared";
import { createNativeEmbedder } from "../../models/src/native.js";
import {
  buildRelease,
  type CollectionDoc,
  FileCache,
  openRelease,
  searchVectors,
} from "../src/index.js";
import { makeCorpus, Vocabulary } from "./corpus.js";

const args = process.argv.slice(2);
const set = args[0] === "real" ? "real" : "synthetic";
const opt = (name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
};
const cacheDir = opt("--cache");
const QUERIES = 200;
const model = embeddingModel(DEFAULT_EMBEDDING_MODEL_ID);
if (!model) throw new Error("no default model");

function passages(): string[] {
  if (set === "synthetic") {
    const count = Number(process.env.BENCH_PASSAGES ?? 120_000);
    const vocab = new Vocabulary(150_000, 1644);
    const page = makeCorpus(vocab, { pages: 50_000, seed: 1644 });
    const out: string[] = [];
    for (let n = 1; out.length < count; n++)
      for (const s of page(n).values.sections as { heading: string; text: string }[])
        if (out.length < count)
          out.push(
            `${s.heading}\n${s.text
              .split(" ")
              .slice(0, Number(process.env.BENCH_WORDS ?? 120))
              .join(" ")}`,
          );
    return out;
  }
  const seen = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
      const path = join(dir, name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && name.endsWith(".md"))
        for (const p of readFileSync(path, "utf8").split(/\n\n+/))
          if (p.trim().length >= 60) seen.add(p.trim().slice(0, 1200));
    }
  };
  walk(join(import.meta.dir, "../../.."));
  const extra = opt("--texts");
  if (extra)
    for (const line of readFileSync(extra, "utf8").split("\n"))
      if (line.trim().length >= 60) seen.add(line.trim());
  return [...seen].sort();
}

async function vectors(
  texts: readonly string[],
  kind: "passage" | "query",
  name: string,
): Promise<Float32Array[]> {
  const file = cacheDir ? join(cacheDir, `${set}-${name}-${texts.length}.f32`) : null;
  const dims = model?.dims as number;
  if (file && existsSync(file)) {
    const all = new Float32Array(readFileSync(file).buffer.slice(0));
    return Array.from({ length: texts.length }, (_v, i) => all.subarray(i * dims, (i + 1) * dims));
  }
  const embedder = await createNativeEmbedder(model as NonNullable<typeof model>, {
    threads: Number(process.env.BENCH_THREADS ?? 8),
  });
  const out: Float32Array[] = [];
  const started = performance.now();
  for (let i = 0; i < texts.length; i += 64) {
    out.push(...(await embedder.embed(texts.slice(i, i + 64), kind)));
    if (i % 6400 === 0)
      console.error(
        `${name}: ${i} of ${texts.length} after ${Math.round((performance.now() - started) / 1000)} s`,
      );
  }
  await embedder.release();
  if (file) {
    mkdirSync(cacheDir as string, { recursive: true });
    const all = new Float32Array(out.length * dims);
    out.forEach((v, i) => {
      all.set(v, i * dims);
    });
    writeFileSync(file, new Uint8Array(all.buffer));
  }
  return out;
}

const texts = passages();
const corpus = texts.slice(0, texts.length - QUERIES);
const held = texts.slice(texts.length - QUERIES);
console.error(`${set}: ${corpus.length} passages, ${held.length} queries`);
const passageVectors = await vectors(corpus, "passage", "passages");
const queryVectors = await vectors(held, "query", "queries");

async function release(partitionMinVectors: number) {
  const files = new Map<string, Uint8Array>();
  const byText = new Map(corpus.map((t, i) => [t, passageVectors[i] as Float32Array]));
  const docs: CollectionDoc[] = corpus.map((t, i) => ({
    id: `p${i}`,
    lang: "de",
    values: { title: `p${i}`, sections: [{ anchor: "a", heading: "", text: t }] },
  }));
  const t0 = performance.now();
  const built = await buildRelease(docs, {
    schema: { fields: { title: { kind: "text" }, sections: { kind: "passages", vector: true } } },
    sink: (n, d) => void files.set(n, d),
    // With an empty heading the engine embeds the passage's text as it is.
    embed: async (batch) => batch.map((t) => byText.get(t) as Float32Array),
    vectorModel: { id: "bench", dims: model?.dims as number },
    tuning: { partitionMinVectors, packMaxBytes: 0 },
  });
  const buildMs = performance.now() - t0;
  let read = 0;
  const cache = new FileCache(
    {
      read: async (f) => {
        const d = files.get(f) as Uint8Array;
        read += d.length;
        return d;
      },
    },
    Number.POSITIVE_INFINITY,
  );
  return {
    opened: await openRelease(built.manifest, cache),
    buildMs,
    read: () => read,
    manifest: built.manifest,
  };
}

const flat = await release(Number.POSITIVE_INFINITY);
const part = await release(1);
const lists = part.opened.segments[0]?.reader.manifest.vectors?.partitions?.lists.length ?? 0;

const truth: number[][] = [];
for (const q of queryVectors)
  truth.push(
    (
      await searchVectors(flat.opened, {
        vector: q,
        limit: 10,
        minSimilarity: -1,
        rescore: corpus.length,
      })
    ).map((h) => h.key),
  );

async function measure(
  label: string,
  run: (q: Float32Array) => Promise<number[]>,
): Promise<string> {
  let hit = 0;
  let total = 0;
  const times: number[] = [];
  for (const [i, q] of queryVectors.entries()) {
    const t = performance.now();
    const keys = await run(q);
    times.push(performance.now() - t);
    const want = new Set(truth[i]);
    hit += keys.filter((k) => want.has(k)).length;
    total += want.size;
  }
  times.sort((a, b) => a - b);
  return `| ${label} | ${(hit / total).toFixed(3)} | ${(times[Math.floor(times.length / 2)] as number).toFixed(1)} ms | ${(times[Math.floor(times.length * 0.95)] as number).toFixed(1)} ms |`;
}

const rows = [
  `Set: ${set}, ${corpus.length} passages, ${QUERIES} held-out queries, ${lists} lists. Build: flat ${Math.round(flat.buildMs / 1000)} s, partitioned ${Math.round(part.buildMs / 1000)} s.`,
  "",
  "| Search | Recall@10 | p50 | p95 |",
  "|---|---|---|---|",
];
rows.push(
  await measure("flat, default rescore", async (q) =>
    (await searchVectors(flat.opened, { vector: q, limit: 10, minSimilarity: -1 })).map(
      (h) => h.key,
    ),
  ),
);
for (const rescore of [200, 1000])
  rows.push(
    await measure(`flat, rescore ${rescore}`, async (q) =>
      (await searchVectors(flat.opened, { vector: q, limit: 10, minSimilarity: -1, rescore })).map(
        (h) => h.key,
      ),
    ),
  );
rows.push(
  await measure("partitioned, default probe", async (q) =>
    (await searchVectors(part.opened, { vector: q, limit: 10, minSimilarity: -1 })).map(
      (h) => h.key,
    ),
  ),
);
for (const probe of [8, 16, 24, 32, 48])
  rows.push(
    await measure(`partitioned, probe ${probe}`, async (q) =>
      (await searchVectors(part.opened, { vector: q, limit: 10, minSimilarity: -1, probe })).map(
        (h) => h.key,
      ),
    ),
  );
console.log(rows.join("\n"));

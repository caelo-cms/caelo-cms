// SPDX-License-Identifier: MPL-2.0

/**
 * Chooses the default embedding model (#1650): quality on the labelled
 * site-search set (semantic-corpus.ts), speed and memory of both runtimes,
 * and how far the gateway's WebAssembly query vectors stray from the
 * job's native ones.
 *
 *   BENCH_MODELS_DIR=<dir> bun run bench/semantic.ts            # every candidate
 *   BENCH_MODELS_DIR=<dir> bun run bench/semantic.ts granite97  # one
 *
 * `<dir>` holds each candidate in the catalog layout
 * (`<id>/<revision>/{model.onnx,tokenizer.json}`); `bun run bench/semantic.ts
 * --fetch` downloads them there first (about 1.8 GB). The probes (cold
 * start, memory, query latency) run in a fresh process per model and
 * runtime, so one runtime's memory does not count against the other.
 *
 * Quality: per site (a site search sees one site), pages ranked by their
 * best passage. MRR@10 and recall@5 per query kind; `cross` queries have
 * their only answer in the other language, so they also show whether a
 * model aligns languages. "hybrid" is the engine's word search fused with
 * the vector ranking (RRF, k = 60), the way the gateway answers when the
 * profile turns semantic search on.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmbedder, type Embedder, fetchModel, type OrtApi } from "@caelo-cms/models";
import type { EmbeddingModel } from "@caelo-cms/shared";
import { EMBEDDING_MODELS } from "@caelo-cms/shared";
import * as ortNode from "onnxruntime-node";
import * as ortWeb from "onnxruntime-web";
import { CANDIDATES } from "./semantic-candidates.js";
import { EVAL_PAGES, EVAL_QUERIES } from "./semantic-corpus.js";
import { evaluate } from "./semantic-eval.js";

const DIR = process.env.BENCH_MODELS_DIR ?? join(process.cwd(), ".bench-models");

const native = (m: EmbeddingModel, threads = 1): Promise<Embedder> =>
  createEmbedder(m, ortNode as unknown as OrtApi, {
    dir: DIR,
    session: {
      executionProviders: ["cpu"],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    },
  });

const wasm = (m: EmbeddingModel): Promise<Embedder> => {
  ortWeb.env.wasm.numThreads = 1;
  return createEmbedder(m, ortWeb as unknown as OrtApi, {
    dir: DIR,
    session: { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
  });
};

function pct(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
}

const PROBE_QUERIES = EVAL_QUERIES.map((q) => q.q);

/** Runs in a child process: one model on one runtime, from a cold process. */
async function probe(id: string, runtime: "native" | "wasm"): Promise<void> {
  const m = CANDIDATES.find((c) => c.id === id) as EmbeddingModel;
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const e = runtime === "native" ? await native(m) : await wasm(m);
  const loadMs = performance.now() - t0;
  const first = performance.now();
  await e.embed([PROBE_QUERIES[0] as string], "query");
  const firstMs = performance.now() - first;
  const times: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (const q of PROBE_QUERIES) {
      const a = performance.now();
      await e.embed([q], "query");
      times.push(performance.now() - a);
    }
  }
  // A typical section: heading plus about 120 words.
  const passage = `Versand und Lieferung\n${"Innerhalb Deutschlands liefern wir in zwei bis vier Werktagen, ab 50 Euro ohne Versandkosten. ".repeat(8)}`;
  const pt: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = performance.now();
    await e.embed([passage], "passage");
    pt.push(performance.now() - a);
  }
  const rssMb = (process.memoryUsage().rss - rss0) / 1e6;
  console.log(
    JSON.stringify({
      loadMs,
      firstMs,
      p50: pct(times, 0.5),
      p95: pct(times, 0.95),
      passageMs: pct(pt, 0.5),
      rssMb,
    }),
  );
}

/** Passages per second on `threads` native threads, for the index job's estimate. */
async function throughput(m: EmbeddingModel, threads: number): Promise<number> {
  const e = await native(m, threads);
  const base = EVAL_PAGES.flatMap((p) =>
    p.sections.map((s) => `${s.heading}\n${s.text} ${s.text} ${s.text}`),
  );
  const texts = Array.from({ length: 256 }, (_, i) => base[i % base.length] as string);
  await e.embed(texts.slice(0, 16), "passage");
  const t = performance.now();
  await e.embed(texts, "passage");
  const perSec = texts.length / ((performance.now() - t) / 1000);
  await e.release();
  return perSec;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--probe") return probe(args[1] as string, args[2] as "native" | "wasm");
  if (args[0] === "--fetch") {
    for (const m of CANDIDATES)
      for (const f of await fetchModel(DIR, m)) console.log(m.id, f.file, f.action);
    return;
  }
  const picked = args.length > 0 ? CANDIDATES.filter((c) => args.includes(c.id)) : CANDIDATES;
  const results: Record<string, unknown> = {};
  for (const m of picked) {
    const probes: Record<string, unknown> = {};
    for (const runtime of ["native", "wasm"] as const) {
      const r = spawnSync(process.execPath, [import.meta.path, "--probe", m.id, runtime], {
        env: { ...process.env, BENCH_MODELS_DIR: DIR },
        encoding: "utf8",
        timeout: 600_000,
      });
      probes[runtime] =
        r.status === 0
          ? JSON.parse(r.stdout.trim().split("\n").pop() as string)
          : { error: (r.stderr || r.stdout).slice(-400) };
    }
    const nat = await native(m, 4);
    const web = await wasm(m);
    const q = await evaluate(nat, web);
    await nat.release();
    await web.release();
    const tp1 = await throughput(m, 1);
    const tp4 = await throughput(m, 4);
    results[m.id] = {
      licence: m.licence,
      dims: m.dims,
      fileMb: (m.files.model.bytes + m.files.tokenizer.bytes) / 1e6,
      quantization: m.quantization,
      probes,
      throughput: { threads1: tp1, threads4: tp4 },
      ...q,
    };
    console.log(m.id, JSON.stringify(results[m.id]));
  }
  // Raw numbers for semantic-results.md (bench/out/ is not committed).
  const out = process.env.BENCH_OUT ?? join(import.meta.dir, "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "semantic.json"), JSON.stringify(results, null, 1));
}

// Keep the catalog's entries measured: each must be a candidate here.
for (const m of EMBEDDING_MODELS) {
  if (!CANDIDATES.some((c) => c.files.model.sha256 === m.files.model.sha256)) {
    throw new Error(`catalog model ${m.id} is not among the bench candidates`);
  }
}

await main();

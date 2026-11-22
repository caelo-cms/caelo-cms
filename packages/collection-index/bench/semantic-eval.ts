// SPDX-License-Identifier: MPL-2.0

/**
 * Scores an embedding model on the labelled site-search set
 * (semantic-corpus.ts) for #1650: shared by the bench (semantic.ts) and the
 * parity test (src/semantic-parity.test.ts), so the numbers the default was
 * chosen by are the numbers CI keeps.
 *
 * Per site (a site search sees one site), pages ranked by their best
 * passage; MRR@10, recall@1 and recall@5 per query kind.
 */

import type { Embedder } from "@caelo-cms/models";
import {
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  FileCache,
  fuse,
  openRelease,
  searchText,
  searchVectors,
} from "../src/index.js";
import { EVAL_PAGES, EVAL_QUERIES, type EvalQuery } from "./semantic-corpus.js";

export type Metrics = { mrr: number; r1: number; r5: number; n: number };

function score(
  ranked: readonly string[],
  relevant: readonly string[],
): { rr: number; r1: number; r5: number } {
  const at = ranked.findIndex((id) => relevant.includes(id));
  return {
    rr: at >= 0 && at < 10 ? 1 / (at + 1) : 0,
    r1: at === 0 ? 1 : 0,
    r5: at >= 0 && at < 5 ? 1 : 0,
  };
}

function summarise(
  rows: readonly { kind: string; rr: number; r1: number; r5: number }[],
): Record<string, Metrics> {
  const out: Record<string, Metrics> = {};
  for (const kind of ["all", "lexical", "paraphrase", "question", "cross"]) {
    const sel = rows.filter((r) => kind === "all" || r.kind === kind);
    const n = sel.length || 1;
    out[kind] = {
      mrr: sel.reduce((s, r) => s + r.rr, 0) / n,
      r1: sel.reduce((s, r) => s + r.r1, 0) / n,
      r5: sel.reduce((s, r) => s + r.r5, 0) / n,
      n: sel.length,
    };
  }
  return out;
}

const siteOf = (id: string): string => id.split("/")[0] as string;

const SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    sections: { kind: "passages", vector: true },
    site: { kind: "keyword" },
  },
};
const WEIGHTS = { title: 3, "sections.heading": 2, "sections.text": 1 };

function docs(): CollectionDoc[] {
  return EVAL_PAGES.map((p) => ({
    id: p.id,
    lang: p.lang,
    values: { title: p.title, sections: p.sections, site: siteOf(p.id) },
  }));
}

/** What {@link evaluate} measures. */
export interface Evaluation {
  /** Native query and passage vectors, exact cosine. */
  readonly exact: Record<string, Metrics>;
  /** WebAssembly queries against native passages, exact cosine: what the gateway meets. */
  readonly crossRuntime: Record<string, Metrics>;
  /** The engine's word search alone. */
  readonly engineLexical: Record<string, Metrics>;
  /** The engine's vector search (int8 vectors), WebAssembly queries. */
  readonly engineVector: Record<string, Metrics>;
  /** Words and vectors fused (RRF, k = 60), WebAssembly queries. */
  readonly engineHybrid: Record<string, Metrics>;
  readonly parity: { minCos: number; meanCos: number; top1Agree: number; overlap5: number };
}

/**
 * Quality of one model on the labelled set: `nat` embeds the passages (the
 * index job), `web` the queries (the gateway); `nat`'s queries give the
 * same-runtime reference.
 */
export async function evaluate(nat: Embedder, web: Embedder): Promise<Evaluation> {
  const m = nat.model;
  const passages = EVAL_PAGES.flatMap((p) =>
    p.sections.map((s) => ({ page: p.id, text: `${s.heading}\n${s.text}` })),
  );
  const pv = await nat.embed(
    passages.map((p) => p.text),
    "passage",
  );
  const qn = await nat.embed(
    EVAL_QUERIES.map((q) => q.q),
    "query",
  );
  const qw: Float32Array[] = [];
  for (const q of EVAL_QUERIES) qw.push(...(await web.embed([q.q], "query")));
  const dot = (a: Float32Array, b: Float32Array) =>
    a.reduce((s, x, i) => s + x * (b[i] as number), 0);
  const rank = (qv: Float32Array, q: EvalQuery): string[] => {
    const best = new Map<string, number>();
    passages.forEach((p, i) => {
      if (siteOf(p.page) !== siteOf(q.relevant[0] as string)) return;
      const s = dot(qv, pv[i] as Float32Array);
      if (s > (best.get(p.page) ?? -2)) best.set(p.page, s);
    });
    return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
  const exact = EVAL_QUERIES.map((q, i) => ({
    kind: q.kind,
    ...score(rank(qn[i] as Float32Array, q), q.relevant),
  }));
  const cross = EVAL_QUERIES.map((q, i) => ({
    kind: q.kind,
    ...score(rank(qw[i] as Float32Array, q), q.relevant),
  }));
  const parity = EVAL_QUERIES.map((q, i) => {
    const a = rank(qn[i] as Float32Array, q).slice(0, 5);
    const b = rank(qw[i] as Float32Array, q).slice(0, 5);
    return {
      cos: dot(qn[i] as Float32Array, qw[i] as Float32Array),
      top1: a[0] === b[0],
      overlap5: a.filter((x) => b.includes(x)).length / Math.max(1, Math.min(5, a.length)),
    };
  });

  // The engine: the index job's vectors (native), the gateway's query vectors (WebAssembly).
  const files = new Map<string, Uint8Array>();
  const byText = new Map(passages.map((p, i) => [p.text, pv[i] as Float32Array] as const));
  const built = await buildRelease(docs(), {
    schema: SCHEMA,
    sink: (name, data) => void files.set(name, data),
    vectorModel: { id: m.id, dims: m.dims },
    embed: async (texts) => texts.map((t) => byText.get(t) as Float32Array),
  });
  const cache = new FileCache(
    { read: async (f) => files.get(f) as Uint8Array },
    Number.POSITIVE_INFINITY,
  );
  const release = await openRelease(built.manifest, cache);
  const idOf = new Map<number, string>();
  for (const seg of release.segments)
    for await (const d of seg.reader.allStored()) idOf.set(d.key, d.id);
  const lexical: { kind: string; rr: number; r1: number; r5: number }[] = [];
  const vector: typeof lexical = [];
  const hybrid: typeof lexical = [];
  for (const [i, q] of EVAL_QUERIES.entries()) {
    const filter = { keywords: { site: [siteOf(q.relevant[0] as string)] } };
    const words = await searchText(release, {
      text: q.q,
      lang: q.lang,
      weights: WEIGHTS,
      limit: 20,
      typos: true,
      compounds: true,
      filter,
    });
    const vec = await searchVectors(release, {
      vector: qw[i] as Float32Array,
      limit: 20,
      minSimilarity: -1,
      filter,
    });
    const lk = words.hits.map((h) => h.key);
    const vk = vec.map((h) => h.key);
    const fused = fuse(
      [
        { keys: lk, weight: 1 },
        { keys: vk, weight: 1 },
      ],
      20,
    ).map((h) => h.key);
    const ids = (keys: readonly number[]) => keys.map((k) => idOf.get(k) as string);
    lexical.push({ kind: q.kind, ...score(ids(lk), q.relevant) });
    vector.push({ kind: q.kind, ...score(ids(vk), q.relevant) });
    hybrid.push({ kind: q.kind, ...score(ids(fused), q.relevant) });
  }
  return {
    exact: summarise(exact),
    crossRuntime: summarise(cross),
    engineLexical: summarise(lexical),
    engineVector: summarise(vector),
    engineHybrid: summarise(hybrid),
    parity: {
      minCos: Math.min(...parity.map((p) => p.cos)),
      meanCos: parity.reduce((s, p) => s + p.cos, 0) / parity.length,
      top1Agree: parity.filter((p) => p.top1).length / parity.length,
      overlap5: parity.reduce((s, p) => s + p.overlap5, 0) / parity.length,
    },
  };
}

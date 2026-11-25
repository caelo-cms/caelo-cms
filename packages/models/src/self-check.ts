// SPDX-License-Identifier: MPL-2.0

/**
 * The embedders' self-check for a built image: every catalog model embeds a
 * probe query on every runtime the image offers, from the code the image
 * actually runs (a bundle, not this source). A bundled runtime that cannot
 * find its WebAssembly build or its native binding fails here, in the image's
 * CI smoke, instead of on the first semantic search of an install (the
 * admin shipped that way in 0.12.11: ONNX Runtime inlined into a server
 * chunk looked for `ort-wasm-simd-threaded.mjs` next to the chunk).
 *
 * Two runtimes of one model must agree on the probe's vector: an index
 * built natively is searched with WebAssembly vectors.
 */

import { EMBEDDING_MODELS, type EmbeddingModel } from "@caelo-cms/shared";
import type { Embedder } from "./embedder.js";

/** Creates an embedder of one model on one runtime. */
export type EmbedderFactory = (model: EmbeddingModel) => Promise<Embedder>;

/** One model on one runtime. */
export interface EmbedderCheck {
  readonly runtime: string;
  readonly model: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** The self-check's report: `ok` only when every check passed. */
export interface EmbedderSelfCheckReport {
  readonly ok: boolean;
  readonly checks: readonly EmbedderCheck[];
}

const PROBE = "opening hours of the shop";

/** Runtimes of one model must agree at least this well (cosine) on the probe. */
export const RUNTIME_AGREEMENT = 0.99;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

async function probe(factory: EmbedderFactory, model: EmbeddingModel): Promise<Float32Array> {
  const embedder = await factory(model);
  try {
    const [vector] = await embedder.embed([PROBE], "query");
    if (!vector) throw new Error("the embedder returned no vector");
    if (vector.length !== model.dims)
      throw new Error(`${vector.length} dimensions, the catalog says ${model.dims}`);
    if (!vector.every(Number.isFinite)) throw new Error("the vector holds a non-finite value");
    if (!vector.some((v) => v !== 0)) throw new Error("the vector is all zeros");
    return vector;
  } finally {
    await embedder.release();
  }
}

/**
 * Embed the probe with every model on every runtime.
 *
 * @param runtimes the image's runtimes by name (`wasm`, `native`), each
 *   taken from the image's own built code.
 * @param models the models to check; the whole catalog by default.
 */
export async function checkEmbedders(
  runtimes: Readonly<Record<string, EmbedderFactory>>,
  models: readonly EmbeddingModel[] = EMBEDDING_MODELS,
): Promise<EmbedderSelfCheckReport> {
  const checks: EmbedderCheck[] = [];
  for (const model of models) {
    const vectors: Array<{ runtime: string; vector: Float32Array }> = [];
    for (const [runtime, factory] of Object.entries(runtimes)) {
      try {
        vectors.push({ runtime, vector: await probe(factory, model) });
        checks.push({ runtime, model: model.id, ok: true });
      } catch (e) {
        checks.push({ runtime, model: model.id, ok: false, error: (e as Error).message });
      }
    }
    const [first, ...rest] = vectors;
    if (!first) continue;
    for (const other of rest) {
      const agreement = cosine(first.vector, other.vector);
      if (agreement < RUNTIME_AGREEMENT)
        checks.push({
          runtime: `${first.runtime}~${other.runtime}`,
          model: model.id,
          ok: false,
          error: `the runtimes disagree on the probe (cosine ${agreement.toFixed(4)}, at least ${RUNTIME_AGREEMENT})`,
        });
    }
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

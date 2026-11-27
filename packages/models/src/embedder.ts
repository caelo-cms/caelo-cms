// SPDX-License-Identifier: MPL-2.0

/**
 * Turns texts into vectors with a catalog model on an ONNX Runtime (#1650).
 * The same code runs on both runtimes: `onnxruntime-node` in the index job
 * (native.ts) and `onnxruntime-web`'s WebAssembly build in the gateway
 * (wasm.ts), so the two differ only in the kernels underneath.
 *
 * The graph is created from verified bytes (files.ts), with no external
 * data file and no custom operator library: the model is data for the
 * runtime's standard operators, never code.
 *
 * The graph is the derived one (#1782): without its token table, which
 * stays on disk and is read row by row (token-table.ts). The embedder
 * gathers a text's rows itself and hands them to the graph, which
 * dequantises them in its next node exactly as the publisher's graph does
 * after its own lookup: same vectors, about a third of the session's
 * memory.
 *
 * One text per run, never a padded batch. The catalog's models are
 * dynamically quantised: each layer's activations are scaled by the
 * minimum and maximum of the whole input tensor, so a text's vector would
 * depend on the other texts (and their padding) in its batch. Measured on
 * Granite 97M: the same passage alone and in a batch of 40 agree only to
 * cosine 0.976 on average (0.965 at worst), while alone on native and alone
 * on WebAssembly agree to 0.996. One text per run keeps a passage's vector
 * a function of its text, so the gateway's query (always alone) meets the
 * index under the same conditions, a rebuild reproduces the old vectors,
 * and nothing is lost: with intra-op threads a single text runs as fast as
 * a batch (bench/semantic-results.md). Runs are serialised per embedder:
 * the native session runs synchronously on the calling thread with every
 * thread it was given, and the WebAssembly runtime takes one call at a time.
 */

import type { EmbeddingModel } from "@caelo-cms/shared";
import { embeddingModelFingerprint } from "@caelo-cms/shared";
import type { InferenceSession, Tensor } from "onnxruntime-common";
import { readModelFiles } from "./files.js";
import { TokenTable } from "./token-table.js";
import { ModelTokenizer } from "./tokenize.js";

/** Embeds texts with one model. */
export interface Embedder {
  readonly model: EmbeddingModel;
  /** What an index records as its vector model (catalog id + graph digest). */
  readonly fingerprint: string;
  /** One L2-normalised vector per text, in order. */
  embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]>;
  /** Frees the session. */
  release(): Promise<void>;
}

/** The tensor element types the embedder feeds. */
type FeedType = "int64" | "uint8" | "int8";

/** The part of an ONNX Runtime package the embedder uses. */
export interface OrtApi {
  readonly InferenceSession: {
    create(data: Uint8Array, options?: InferenceSession.SessionOptions): Promise<InferenceSession>;
  };
  readonly Tensor: new (
    type: FeedType,
    data: BigInt64Array | Uint8Array | Int8Array,
    dims: readonly number[],
  ) => Tensor;
}

/**
 * Verified files to a tokenizer, a token table and a session. Its own
 * function so the graph's bytes are not kept alive by the embedder's
 * closures once the runtime holds its copy.
 */
async function load(
  model: EmbeddingModel,
  ort: OrtApi,
  options: { readonly dir: string; readonly session: InferenceSession.SessionOptions },
): Promise<{ tokenizer: ModelTokenizer; table: TokenTable; session: InferenceSession }> {
  const files = await readModelFiles(options.dir, model);
  const d = model.derived;
  return {
    tokenizer: new ModelTokenizer(model, files.tokenizer),
    table: new TokenTable(files.tablePath, d.rows, d.width),
    session: await ort.InferenceSession.create(files.graph, options.session),
  };
}

/** Builds an embedder from verified files on a runtime. */
export async function createEmbedder(
  model: EmbeddingModel,
  ort: OrtApi,
  options: { readonly dir: string; readonly session: InferenceSession.SessionOptions },
): Promise<Embedder> {
  const { tokenizer, table, session } = await load(model, ort, options);
  const d = model.derived;
  for (const input of [...model.inputs, d.tableInput]) {
    if (!session.inputNames.includes(input)) {
      table.close();
      throw new Error(
        `embedding model ${model.id}: the graph has no input "${input}" (it has ${session.inputNames.join(", ")})`,
      );
    }
  }
  if (!session.outputNames.includes(model.output)) {
    table.close();
    throw new Error(`embedding model ${model.id}: the graph has no output "${model.output}"`);
  }
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const runOne = async (tokens: readonly number[]): Promise<Float32Array> => {
    const n = tokens.length;
    const ids = BigInt64Array.from(tokens, (t) => BigInt(t));
    const rows = table.gather(tokens);
    const feeds: Record<string, Tensor> = {
      input_ids: new ort.Tensor("int64", ids, [1, n]),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
      [d.tableInput]: new ort.Tensor(
        d.elementType,
        d.elementType === "int8" ? new Int8Array(rows.buffer) : rows,
        [1, n, d.width],
      ),
    };
    if (model.inputs.includes("token_type_ids")) {
      feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(n), [1, n]);
    }
    const out = await session.run(feeds);
    const states = out[model.output] as Tensor;
    const data = states.data as Float32Array;
    const dims = states.dims[2] as number;
    if (dims !== model.dims) {
      throw new Error(
        `embedding model ${model.id}: ${dims} dimensions, the catalog says ${model.dims}`,
      );
    }
    const v = new Float32Array(dims);
    if (model.pooling === "cls") {
      v.set(data.subarray(0, dims));
    } else {
      for (let t = 0; t < n; t++) {
        for (let j = 0; j < dims; j++) v[j] = (v[j] as number) + (data[t * dims + j] as number);
      }
      for (let j = 0; j < dims; j++) v[j] = (v[j] as number) / n;
    }
    let norm = 0;
    for (let j = 0; j < dims; j++) norm += (v[j] as number) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dims; j++) v[j] = (v[j] as number) / norm;
    return v;
  };

  return {
    model,
    fingerprint: embeddingModelFingerprint(model),
    embed: (texts, kind) =>
      serial(async () => {
        const out: Float32Array[] = [];
        for (const text of texts) out.push(await runOne(tokenizer.encode(text, kind).ids));
        return out;
      }),
    release: () =>
      serial(async () => {
        await session.release();
        table.close();
      }),
  };
}

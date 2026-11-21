// SPDX-License-Identifier: MPL-2.0

/**
 * The WebAssembly embedder (#1650): ONNX Runtime's WebAssembly build, for
 * the gateway, which embeds one visitor query per semantic search. A
 * visitor's text never reaches native code next to the gateway's
 * credentials (the reasoning behind the capture job, #1217): the tokenizer
 * is JavaScript and the graph runs inside the WebAssembly sandbox.
 *
 * Threads: the build is ONNX Runtime's SIMD + threads build, and its
 * worker threads run under Bun 1.4.4 (4 threads: a query in 5.5 ms instead
 * of 9.8 ms on an M3). The gateway has one vCPU, so it asks for one
 * thread: more would only contend (bench/semantic-results.md).
 */

import { pathToFileURL } from "node:url";
import type { EmbeddingModel } from "@caelo-cms/shared";
import * as ort from "onnxruntime-web";
import { createEmbedder, type Embedder, type OrtApi } from "./embedder.js";
import { modelsDirFromEnv } from "./files.js";

/** The env var naming the directory of ONNX Runtime's `.wasm`/`.mjs` (a bundled gateway sets it). */
export const ORT_WASM_DIR_ENV = "CAELO_ORT_WASM_DIR";

/**
 * An embedder on ONNX Runtime WebAssembly. `wasmDir` holds
 * `ort-wasm-simd-threaded.{wasm,mjs}`; unset, the runtime finds them next
 * to its own module (an unbundled checkout).
 */
export function createWasmEmbedder(
  model: EmbeddingModel,
  options: { readonly dir?: string; readonly wasmDir?: string; readonly threads?: number } = {},
): Promise<Embedder> {
  ort.env.wasm.numThreads = options.threads ?? 1;
  ort.env.wasm.proxy = false;
  const wasmDir = options.wasmDir ?? process.env[ORT_WASM_DIR_ENV];
  if (wasmDir) ort.env.wasm.wasmPaths = `${pathToFileURL(wasmDir).href.replace(/\/?$/, "/")}`;
  return createEmbedder(model, ort as unknown as OrtApi, {
    dir: options.dir ?? modelsDirFromEnv(),
    session: { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
  });
}

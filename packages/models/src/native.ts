// SPDX-License-Identifier: MPL-2.0

/**
 * The native embedder (#1650): ONNX Runtime's CPU build, for the
 * `collection_index` job, where passages of a whole site are embedded and
 * native kernels are about five times faster than WebAssembly
 * (bench/semantic-results.md). The job runs no visitor input, and reads
 * only files the image carries.
 */

import { availableParallelism } from "node:os";
import type { EmbeddingModel } from "@caelo-cms/shared";
import * as ort from "onnxruntime-node";
import { createEmbedder, type Embedder, type OrtApi } from "./embedder.js";
import { modelsDirFromEnv } from "./files.js";

/** An embedder on native ONNX Runtime, using `threads` (default: every CPU). */
export function createNativeEmbedder(
  model: EmbeddingModel,
  options: { readonly dir?: string; readonly threads?: number } = {},
): Promise<Embedder> {
  return createEmbedder(model, ort as unknown as OrtApi, {
    dir: options.dir ?? modelsDirFromEnv(),
    session: {
      executionProviders: ["cpu"],
      intraOpNumThreads: options.threads ?? availableParallelism(),
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    },
  });
}

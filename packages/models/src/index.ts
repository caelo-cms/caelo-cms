// SPDX-License-Identifier: MPL-2.0

/**
 * `@caelo-cms/models` — the embedding-model catalog's runtime (#1650). The
 * catalog itself is data in `@caelo-cms/shared` (embedding-models.ts). This
 * entry has no ONNX Runtime import; the embedders are `./native` (index
 * job) and `./wasm` (gateway), so each image bundles only its runtime.
 */

export { CompactTokenizer, deriveTokenizer, type SplitPattern } from "./bpe.js";
export { type DerivedBytes, deriveModelFiles } from "./derive.js";
export type { Embedder, OrtApi } from "./embedder.js";
export { createEmbedder } from "./embedder.js";
export {
  type FetchedFile,
  fetchModel,
  MODEL_NOTICE,
  modelNotice,
  sourceUrl,
  writeModelNotice,
} from "./fetch.js";
export {
  type LoadableModelFiles,
  MODELS_DIR_ENV,
  ModelFileError,
  modelDir,
  modelFilePath,
  modelsDirFromEnv,
  readModelFiles,
  readVerifiedModelFile,
  sha256Hex,
  verifyModelFileInPlace,
} from "./files.js";
export { modelsForTests } from "./testing.js";
export { type SplitGraph, splitTokenTable, TokenTable } from "./token-table.js";
export { type Encoded, ModelTokenizer } from "./tokenize.js";

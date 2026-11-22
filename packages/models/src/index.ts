// SPDX-License-Identifier: MPL-2.0

/**
 * `@caelo-cms/models` — the embedding-model catalog's runtime (#1650). The
 * catalog itself is data in `@caelo-cms/shared` (embedding-models.ts). This
 * entry has no ONNX Runtime import; the embedders are `./native` (index
 * job) and `./wasm` (gateway), so each image bundles only its runtime.
 */

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
  MODELS_DIR_ENV,
  ModelFileError,
  modelDir,
  modelFilePath,
  modelsDirFromEnv,
  readModelFiles,
  readVerifiedModelFile,
  sha256Hex,
} from "./files.js";
export { modelsForTests } from "./testing.js";
export { type Encoded, ModelTokenizer } from "./tokenize.js";

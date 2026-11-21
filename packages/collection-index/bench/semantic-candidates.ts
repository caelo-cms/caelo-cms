// SPDX-License-Identifier: MPL-2.0

/**
 * The embedding models measured for the catalog (#1650), each in its
 * publisher's own ONNX export, pinned like a catalog entry. The bench
 * (semantic.ts) runs them; the catalog takes its entries from the winners.
 */

import type { EmbeddingModel } from "@caelo-cms/shared";

const hf = (
  id: string,
  repo: string,
  revision: string,
  model: [string, string, number],
  tokenizer: [string, string, number],
  rest: Pick<
    EmbeddingModel,
    | "dims"
    | "pooling"
    | "prefixes"
    | "padTokenId"
    | "inputs"
    | "output"
    | "licence"
    | "quantization"
  >,
): EmbeddingModel => ({
  id,
  label: id,
  description: id,
  source: { host: "huggingface.co", repo, revision },
  licenceUrl: "",
  copyright: "",
  files: {
    model: { name: "model.onnx", path: model[0], sha256: model[1], bytes: model[2] },
    tokenizer: {
      name: "tokenizer.json",
      path: tokenizer[0],
      sha256: tokenizer[1],
      bytes: tokenizer[2],
    },
  },
  maxTokens: 512,
  languages: "",
  ...rest,
});

const XLMR = { padTokenId: 1 } as const;
const E5 = { prefixes: { query: "query: ", passage: "passage: " }, pooling: "mean" } as const;

/** The candidates (#1650 scope), each in the publisher's own quantised export. */
export const CANDIDATES: readonly EmbeddingModel[] = [
  hf(
    "e5-small",
    "intfloat/multilingual-e5-small",
    "614241f622f53c4eeff9890bdc4f31cfecc418b3",
    [
      "onnx/model_qint8_avx512_vnni.onnx",
      "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88",
      118_346_824,
    ],
    [
      "onnx/tokenizer.json",
      "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      17_082_730,
    ],
    {
      ...XLMR,
      ...E5,
      dims: 384,
      inputs: ["input_ids", "attention_mask", "token_type_ids"],
      output: "last_hidden_state",
      licence: "MIT",
      quantization: "qint8",
    },
  ),
  hf(
    "minilm-l12",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
    [
      "onnx/model_qint8_avx512.onnx",
      "783fea82d71a58179b830a4dbd2d58447e640609e98eedf9ffa12622d375a672",
      118_412_398,
    ],
    [
      "tokenizer.json",
      "2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8",
      9_081_518,
    ],
    {
      ...XLMR,
      pooling: "mean",
      prefixes: { query: "", passage: "" },
      dims: 384,
      inputs: ["input_ids", "attention_mask", "token_type_ids"],
      output: "last_hidden_state",
      licence: "Apache-2.0",
      quantization: "qint8",
    },
  ),
  hf(
    "granite97",
    "ibm-granite/granite-embedding-97m-multilingual-r2",
    "835ad14087e140460703cf0fae09f97d469d65c2",
    [
      "onnx/model_quint8_avx2.onnx",
      "a6022dd8220ea6f6595562a1328ee216f4a94faa55362f2f4747c80f1e78772e",
      98_247_878,
    ],
    [
      "tokenizer.json",
      "4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f",
      25_301_672,
    ],
    {
      padTokenId: 179_935,
      pooling: "cls",
      prefixes: { query: "", passage: "" },
      dims: 384,
      inputs: ["input_ids", "attention_mask"],
      output: "last_hidden_state",
      licence: "Apache-2.0",
      quantization: "quint8",
    },
  ),
  hf(
    "granite97-fp32",
    "ibm-granite/granite-embedding-97m-multilingual-r2",
    "835ad14087e140460703cf0fae09f97d469d65c2",
    [
      "onnx/model.onnx",
      "68e592b160673d30250824c1116bc6ab33f70efb22b97c9e1d7ce1e69c1c9d70",
      390_004_608,
    ],
    [
      "tokenizer.json",
      "4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f",
      25_301_672,
    ],
    {
      padTokenId: 179_935,
      pooling: "cls",
      prefixes: { query: "", passage: "" },
      dims: 384,
      inputs: ["input_ids", "attention_mask"],
      output: "last_hidden_state",
      licence: "Apache-2.0",
      quantization: "fp32",
    },
  ),
  hf(
    "e5-base",
    "intfloat/multilingual-e5-base",
    "d128750597153bb5987e10b1c3493a34e5a4502a",
    [
      "onnx/model_qint8_avx512_vnni.onnx",
      "2523551878658b305550d8759443822dbfda9ed9c8012ef2c354ba2c5b9de503",
      278_686_411,
    ],
    [
      "onnx/tokenizer.json",
      "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
      17_082_660,
    ],
    {
      ...XLMR,
      ...E5,
      dims: 768,
      inputs: ["input_ids", "attention_mask"],
      output: "last_hidden_state",
      licence: "MIT",
      quantization: "qint8",
    },
  ),
  hf(
    "arctic-m-v2",
    "Snowflake/snowflake-arctic-embed-m-v2.0",
    "95c2741480856aa9666782eb4afe11959938017f",
    [
      "onnx/model_int8.onnx",
      "03d923bb1850ebdccb068e2f3abd8aa43fe81c50d07d037ef103fe3d0fb78e3b",
      310_916_060,
    ],
    [
      "tokenizer.json",
      "f1cc44ad7faaeec47241864835473fd5403f2da94673f3f764a77ebcb0a803ec",
      17_083_009,
    ],
    {
      ...XLMR,
      pooling: "cls",
      prefixes: { query: "query: ", passage: "" },
      dims: 768,
      inputs: ["input_ids", "attention_mask"],
      output: "token_embeddings",
      licence: "Apache-2.0",
      quantization: "int8",
    },
  ),
];

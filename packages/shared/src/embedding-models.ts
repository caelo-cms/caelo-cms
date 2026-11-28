// SPDX-License-Identifier: MPL-2.0

/**
 * The core catalog of embedding models (epic #1644, R7, issue #1650).
 *
 * A plugin that wants semantic search names a model of this catalog in its
 * configuration (a `catalogModel` config leaf); no plugin ships a model or
 * a binary. Each entry pins the publisher's repository at one revision and
 * every file by SHA-256, so what runs is what was reviewed: the files are
 * fetched once, at image build (`packages/models/scripts/fetch-models.ts`),
 * verified, and verified again when a process loads them. Only MIT and
 * Apache-2.0 models qualify (CLAUDE.md §3); the licence and its notice ship
 * with the files (THIRD_PARTY_NOTICES).
 *
 * This module is data only (no runtime dependency): the plugin SDK
 * validates config values against {@link EMBEDDING_MODEL_IDS}, the admin
 * shows the entries, and `@caelo-cms/models` loads them (natively in the
 * index job, as WebAssembly in the gateway).
 *
 * Why one model: every entry ships in the admin and the gateway image
 * (about 125 MB each), so an entry is added when a measurement shows a
 * site needs what the default cannot do, not to offer a choice for its
 * own sake. `packages/collection-index/bench/semantic.ts` measures the
 * candidates on a labelled German/English site-search set;
 * `bench/semantic-results.md` holds the numbers that chose the default.
 */

/** One file of a model, pinned by content. */
export interface EmbeddingModelFile {
  /** File name in the model's directory (`model.onnx`). */
  readonly name: string;
  /** Path in the source repository at {@link EmbeddingModel.source}'s revision. */
  readonly path: string;
  /** SHA-256 of the file, lowercase hex. */
  readonly sha256: string;
  readonly bytes: number;
}

/** A file Caelo derives from a model's pinned files when it fetches them (#1782), pinned the same way. */
export interface EmbeddingDerivedFile {
  /** File name in the model's directory. */
  readonly name: string;
  /** SHA-256 of the file, lowercase hex. */
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * The files a process loads (#1782), derived at fetch time from the
 * publisher's graph and tokenizer (`packages/models/src/derive.ts`). They
 * compute exactly what the publisher's files compute, so the model keeps
 * its fingerprint; images carry only these.
 *
 * - `graph`: the publisher's graph without its token table and the
 *   `Gather` that reads it; the gathered rows are its input `tableInput`.
 * - `table`: that table, `rows × width` bytes, read row by row.
 * - `tokenizer`: the tokenizer as typed arrays (about 20 MB in memory
 *   instead of 138 MB), cutting text exactly as `@huggingface/tokenizers`
 *   cuts it with `tokenizer.json`.
 */
export interface EmbeddingDerivedFiles {
  /** The `Gather` node of the publisher's graph that looks token rows up. */
  readonly gather: string;
  /** The derived graph's input taking the gathered rows (`[batch, tokens, width]`). */
  readonly tableInput: string;
  readonly rows: number;
  readonly width: number;
  readonly elementType: "uint8" | "int8";
  readonly graph: EmbeddingDerivedFile;
  readonly table: EmbeddingDerivedFile;
  readonly tokenizer: EmbeddingDerivedFile;
  /**
   * The pre-tokenizer's split pattern in the JavaScript form
   * `@huggingface/tokenizers` translates `tokenizer.json`'s regex into
   * (`bpe.test.ts` checks the library still produces it).
   */
  readonly splitPattern: { readonly source: string; readonly flags: string };
}

/** One approved embedding model. */
export interface EmbeddingModel {
  /** Stable id plugins name in their configuration. */
  readonly id: string;
  /** What the operator sees ("Granite Embedding 97M, multilingual"). */
  readonly label: string;
  /** One sentence for the operator and the AI: what it is good at. */
  readonly description: string;
  readonly source: {
    readonly host: "huggingface.co";
    readonly repo: string;
    /** The repository commit the files are taken from. */
    readonly revision: string;
  };
  readonly licence: "MIT" | "Apache-2.0";
  readonly licenceUrl: string;
  /** The copyright line the notice names. */
  readonly copyright: string;
  readonly files: {
    /** The ONNX graph; loaded from bytes, so it can name no external file. */
    readonly model: EmbeddingModelFile;
    /** The tokenizer (`tokenizer.json`, Hugging Face tokenizers format). */
    readonly tokenizer: EmbeddingModelFile;
  };
  /** What a process loads, derived from {@link EmbeddingModel.files} (#1782). */
  readonly derived: EmbeddingDerivedFiles;
  /** Vector dimensions. */
  readonly dims: number;
  /** Tokens embedded per text, special tokens included; a longer text is cut. */
  readonly maxTokens: number;
  /** How token states become the text's vector (then L2-normalised). */
  readonly pooling: "cls" | "mean";
  /** Prepended to the text (e5 models were trained with `query: ` / `passage: `). */
  readonly prefixes: { readonly query: string; readonly passage: string };
  /** The tokenizer's padding token id. */
  readonly padTokenId: number;
  /** The graph's inputs, in the names the export uses. */
  readonly inputs: readonly ("input_ids" | "attention_mask" | "token_type_ids")[];
  /** The graph output holding per-token states (`[batch, tokens, dims]`). */
  readonly output: string;
  /** Languages it serves well, as the publisher documents them. */
  readonly languages: string;
  /** How the published file is quantised. */
  readonly quantization: string;
}

/**
 * Granite Embedding 97M multilingual R2 (IBM, Apache-2.0): chosen by the
 * #1650 measurements (bench/semantic-results.md).
 */
const GRANITE_97M_R2: EmbeddingModel = {
  id: "granite-embedding-97m-multilingual-r2",
  label: "Granite Embedding 97M, multilingual",
  description:
    "Small multilingual model (52 languages with retrieval training, German and English among them); finds pages by meaning and across languages.",
  source: {
    host: "huggingface.co",
    repo: "ibm-granite/granite-embedding-97m-multilingual-r2",
    revision: "835ad14087e140460703cf0fae09f97d469d65c2",
  },
  licence: "Apache-2.0",
  licenceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  copyright: "Copyright IBM Corp.",
  files: {
    model: {
      name: "model.onnx",
      path: "onnx/model_quint8_avx2.onnx",
      sha256: "a6022dd8220ea6f6595562a1328ee216f4a94faa55362f2f4747c80f1e78772e",
      bytes: 98_247_878,
    },
    tokenizer: {
      name: "tokenizer.json",
      path: "tokenizer.json",
      sha256: "4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f",
      bytes: 25_301_672,
    },
  },
  derived: {
    gather: "/embeddings/tok_embeddings/Gather",
    tableInput: "/embeddings/tok_embeddings/Gather_output_0_quantized",
    rows: 180_000,
    width: 384,
    elementType: "uint8",
    graph: {
      name: "graph.onnx",
      sha256: "08ab16deaea2daa89309a43ff5d8d1aaafea6aea63902b8f15930829361950d9",
      bytes: 29_127_762,
    },
    table: {
      name: "tokens.bin",
      sha256: "dfa0d1fe4626efce6187ae9dfc7f39336af75fda0e07b2290cca4a3157d7da3b",
      bytes: 69_120_000,
    },
    tokenizer: {
      name: "tokenizer.bin",
      sha256: "f91682d3b56ce49d18682b60c80dd57f9a360c3a3b202eeb8b5188e37f7c30ed",
      bytes: 6_888_959,
    },
    splitPattern: {
      source:
        "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?|\\p{N}{1,3}| ?[^\\p{White_Space}\\p{L}\\p{N}]+[\\r\\n/]*|\\p{White_Space}*[\\r\\n]+|\\p{White_Space}+(?!\\P{White_Space})|\\p{White_Space}+",
      flags: "gu",
    },
  },
  dims: 384,
  maxTokens: 512,
  pooling: "cls",
  prefixes: { query: "", passage: "" },
  padTokenId: 179_935,
  inputs: ["input_ids", "attention_mask"],
  output: "last_hidden_state",
  languages:
    "52 languages with retrieval training (German, English, French, Spanish, Italian, Dutch, Polish, …), 200+ in pretraining",
  quantization: "dynamic int8 (uint8 weights), as published",
};

/** Every approved model. */
export const EMBEDDING_MODELS: readonly EmbeddingModel[] = [GRANITE_97M_R2];

/** Catalog ids, for config validation. */
export const EMBEDDING_MODEL_IDS: readonly string[] = EMBEDDING_MODELS.map((m) => m.id);

/** The model a plugin's config offers by default. */
export const DEFAULT_EMBEDDING_MODEL_ID: string = GRANITE_97M_R2.id;

/** The catalog entry of `id`, or undefined. */
export function embeddingModel(id: string): EmbeddingModel | undefined {
  return EMBEDDING_MODELS.find((m) => m.id === id);
}

/**
 * What an index records as its vector model: the id and the graph's digest.
 * A new revision of the same id is another fingerprint, so an index built
 * with the old files is rebuilt rather than mixed with new query vectors.
 */
export function embeddingModelFingerprint(model: EmbeddingModel): string {
  return `${model.id}@${model.files.model.sha256.slice(0, 12)}`;
}

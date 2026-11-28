// SPDX-License-Identifier: MPL-2.0

/**
 * A tiny catalog model for tests (#1782): a real ONNX graph and a real
 * byte-level BPE `tokenizer.json`, small enough to build in memory, shaped
 * like the catalog's models (a uint8 token table read by a `Gather`,
 * dequantised by the next node; Split + ByteLevel pre-tokenizers, a
 * template, added tokens). Tests derive, fetch, tokenize and embed with it
 * without the real models.
 */

import type { EmbeddingModel } from "@caelo-cms/shared";
import { BYTE_ALPHABET, deriveTokenizer } from "./bpe.js";
import { sha256Hex } from "./files.js";
import { splitTokenTable } from "./token-table.js";

const utf8 = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}
const field = (num: number, payload: readonly number[] | Uint8Array): number[] => [
  ...varint((num << 3) | 2),
  ...varint(payload.length),
  ...payload,
];
const scalar = (num: number, value: number): number[] => [...varint(num << 3), ...varint(value)];
const str = (s: string): number[] => [...utf8.encode(s)];

/** ValueInfoProto of a tensor: elem type and dims (a number or a symbolic name). */
function valueInfo(name: string, elemType: number, dims: readonly (number | string)[]): number[] {
  const shape = dims.flatMap((d) =>
    field(1, typeof d === "number" ? scalar(1, d) : field(2, str(d))),
  );
  return [
    ...field(1, str(name)),
    ...field(2, field(1, [...scalar(1, elemType), ...field(2, shape)])),
  ];
}

function tensor(
  name: string,
  dataType: number,
  dims: readonly number[],
  raw: Uint8Array,
): number[] {
  return [
    ...dims.flatMap((d) => scalar(1, d)),
    ...scalar(2, dataType),
    ...field(8, str(name)),
    ...field(9, raw),
  ];
}

function node(
  op: string,
  name: string,
  inputs: readonly string[],
  outputs: readonly string[],
): number[] {
  return [
    ...inputs.flatMap((i) => field(1, str(i))),
    ...outputs.flatMap((o) => field(2, str(o))),
    ...field(3, str(name)),
    ...field(4, str(op)),
  ];
}

/** The name of the tiny graph's token lookup. */
export const TINY_GATHER = "/embeddings/tok_embeddings/Gather";
/** Row width (and vector dimensions) of the tiny model. */
export const TINY_WIDTH = 8;

/**
 * An ONNX graph: Gather(uint8 table, input_ids) → DequantizeLinear →
 * last_hidden_state, plus a Shape of input_ids as the real graphs have.
 */
export function tinyGraph(rows: number): Uint8Array {
  const table = new Uint8Array(rows * TINY_WIDTH);
  // Deterministic, varied rows.
  let seed = 1782;
  for (let i = 0; i < table.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    table[i] = seed >>> 24;
  }
  const scale = new Uint8Array(4);
  new DataView(scale.buffer).setFloat32(0, 0.03125, true);
  const gathered = `${TINY_GATHER}_output_0_quantized`;
  const graph = [
    ...field(
      1,
      node(
        "Gather",
        TINY_GATHER,
        ["embeddings.tok_embeddings.weight_quantized", "input_ids"],
        [gathered],
      ),
    ),
    ...field(
      1,
      node(
        "DequantizeLinear",
        "/dequantize",
        [gathered, "scale", "zero_point"],
        ["last_hidden_state"],
      ),
    ),
    ...field(1, node("Shape", "/Shape", ["input_ids"], ["input_shape"])),
    ...field(2, str("tiny")),
    ...field(5, tensor("embeddings.tok_embeddings.weight_quantized", 2, [rows, TINY_WIDTH], table)),
    ...field(5, tensor("scale", 1, [], scale)),
    ...field(5, tensor("zero_point", 2, [], Uint8Array.of(128))),
    ...field(11, valueInfo("input_ids", 7, [1, "sequence_length"])),
    ...field(11, valueInfo("attention_mask", 7, [1, "sequence_length"])),
    ...field(12, valueInfo("last_hidden_state", 1, [1, "sequence_length", TINY_WIDTH])),
  ];
  return Uint8Array.from([
    ...scalar(1, 8),
    ...field(8, scalar(2, 17)),
    ...field(2, str("caelo-test")),
    ...field(7, graph),
  ]);
}

/** The Rust regex of the tiny tokenizer's Split (a GPT-2 style word split). */
export const TINY_SPLIT_REGEX =
  " ?\\p{L}+| ?\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s+(?!\\S)|\\s+";
/** The same pattern as `@huggingface/tokenizers` runs it (`bpe.test.ts` checks the translation). */
export const TINY_SPLIT_PATTERN = {
  source:
    " ?\\p{L}+| ?\\p{N}{1,3}| ?[^\\p{White_Space}\\p{L}\\p{N}]+[\\r\\n]*|\\p{White_Space}+(?!\\P{White_Space})|\\p{White_Space}+",
  flags: "gu",
} as const;

/**
 * A byte-level BPE tokenizer.json: every byte but three control bytes,
 * some merges, two special tokens around the text and one more added token.
 */
export function tinyTokenizerJson(): Record<string, unknown> {
  const vocab: Record<string, number> = {};
  let id = 0;
  BYTE_ALPHABET.forEach((c, b) => {
    if (b === 1 || b === 2 || b === 0x7f) return;
    vocab[c] = id++;
  });
  const sp = BYTE_ALPHABET[0x20] as string;
  // "ü" is two bytes in UTF-8, so its token is spelled with their two characters.
  const u = `${BYTE_ALPHABET[0xc3]}${BYTE_ALPHABET[0xbc]}`;
  const merges: [string, string][] = [
    ["h", "e"],
    ["l", "l"],
    ["he", "ll"],
    ["hell", "o"],
    [sp, "w"],
    ["o", "r"],
    [`${sp}w`, "or"],
    ["l", "d"],
    [`${sp}wor`, "ld"],
    ["e", "n"],
    [sp, "t"],
    [`${sp}t`, "e"],
    ["s", "t"],
    ["e", "r"],
    ["c", "h"],
    ["b", "er"],
    [BYTE_ALPHABET[0xc3] as string, BYTE_ALPHABET[0xbc] as string],
    [u, "ber"],
  ];
  for (const [a, b] of merges) if (!(`${a}${b}` in vocab)) vocab[`${a}${b}`] = id++;
  const added = [
    { id: id, content: "<|s|>", special: true },
    { id: id + 1, content: "<|e|>", special: true },
    { id: id + 2, content: "<|x|>", special: false, single_word: true },
  ];
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: added.map((a) => ({
      id: a.id,
      content: a.content,
      single_word: a.single_word ?? false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: a.special,
    })),
    normalizer: null,
    pre_tokenizer: {
      type: "Sequence",
      pretokenizers: [
        {
          type: "Split",
          pattern: { Regex: TINY_SPLIT_REGEX },
          behavior: "Isolated",
          invert: false,
        },
        { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: false },
      ],
    },
    post_processor: {
      type: "TemplateProcessing",
      single: [
        { SpecialToken: { id: "<|s|>", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "<|e|>", type_id: 0 } },
      ],
      pair: [],
      special_tokens: {
        "<|s|>": { id: "<|s|>", ids: [id], tokens: ["<|s|>"] },
        "<|e|>": { id: "<|e|>", ids: [id + 1], tokens: ["<|e|>"] },
      },
    },
    decoder: { type: "ByteLevel", add_prefix_space: true, trim_offsets: true, use_regex: true },
    model: {
      type: "BPE",
      dropout: null,
      unk_token: null,
      continuing_subword_prefix: null,
      end_of_word_suffix: null,
      fuse_unk: false,
      byte_fallback: false,
      ignore_merges: true,
      vocab,
      merges,
    },
  };
}

/** The tiny model's files and its catalog entry, pinned to them. */
export function tinyModel(): {
  readonly model: EmbeddingModel;
  readonly graph: Uint8Array;
  readonly tokenizer: Uint8Array;
} {
  const json = tinyTokenizerJson();
  const tokenizer = utf8.encode(JSON.stringify(json));
  const rows = (json.added_tokens as { id: number }[]).reduce((n, t) => Math.max(n, t.id + 1), 0);
  const graph = tinyGraph(rows);
  const split = splitTokenTable(graph, TINY_GATHER);
  const compact = deriveTokenizer(json, TINY_SPLIT_PATTERN);
  const pin = (name: string, data: Uint8Array) => ({
    name,
    sha256: sha256Hex(data),
    bytes: data.length,
  });
  const model: EmbeddingModel = {
    id: "test-model",
    label: "Test",
    description: "Test",
    source: {
      host: "huggingface.co",
      repo: "example/test",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    licence: "Apache-2.0",
    licenceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    copyright: "Copyright Example",
    files: {
      model: {
        name: "model.onnx",
        path: "onnx/model.onnx",
        sha256: sha256Hex(graph),
        bytes: graph.length,
      },
      tokenizer: {
        name: "tokenizer.json",
        path: "tokenizer.json",
        sha256: sha256Hex(tokenizer),
        bytes: tokenizer.length,
      },
    },
    derived: {
      gather: TINY_GATHER,
      tableInput: split.input,
      rows: split.rows,
      width: split.width,
      elementType: split.elementType,
      graph: pin("graph.onnx", split.graph),
      table: pin("tokens.bin", split.table),
      tokenizer: pin("tokenizer.bin", compact),
      splitPattern: TINY_SPLIT_PATTERN,
    },
    dims: TINY_WIDTH,
    maxTokens: 16,
    pooling: "mean",
    prefixes: { query: "", passage: "" },
    padTokenId: 0,
    inputs: ["input_ids", "attention_mask"],
    output: "last_hidden_state",
    languages: "test",
    quantization: "none",
  };
  return { model, graph, tokenizer };
}

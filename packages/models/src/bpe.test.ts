// SPDX-License-Identifier: MPL-2.0

/**
 * #1782 — the compact tokenizer cuts text exactly like
 * `@huggingface/tokenizers`, whose ids the index's vectors were embedded
 * with: on the tiny model always, and on the catalog's model when it is
 * fetched (with its publisher's `tokenizer.json`), over a large mixed
 * corpus. The catalog's pinned split pattern is the library's translation
 * of the model's regex.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModel, embeddingModel } from "@caelo-cms/shared";
import { Tokenizer } from "@huggingface/tokenizers";
import { CompactTokenizer, deriveTokenizer } from "./bpe.js";
import { modelFilePath } from "./files.js";
import { modelsForTests } from "./testing.js";
import { TINY_SPLIT_PATTERN, tinyTokenizerJson } from "./tiny-model.js";

interface Reference {
  encode(text: string): { ids: number[] };
  pre_tokenizer: { tokenizers: { pattern: RegExp }[] };
}

/** Texts that reach every branch: added tokens, control bytes, scripts, emoji, long runs. */
function edgeTexts(seed: number, random: number): string[] {
  const texts = [
    "",
    " ",
    "  x",
    "\n\n",
    "\t\r\n ",
    "hello world",
    "hellohello world",
    " hello  world ",
    "über alles, Übersicht",
    "<|s|>",
    "a<|s|>b",
    "<|x|>x",
    "x<|x|>",
    "<|s|><|e|>",
    "<|",
    "\u0001\u0002\u007f mixed \u0000",
    "naïve café — “quotes” 😀👍🏽 中文 日本語 한국어 العربية עברית",
    "é ﬁ Ⅻ ①②",
    "I'M YOU'RE they'Ve 'S",
    "1234567890 12.5% €3,99",
    "a".repeat(3000),
    "ab".repeat(2000),
    "http://example.com/a/b?c=d&e=f#g",
    "\ud800 lone \udc00",
    "x y z",
    "​‍﻿",
  ];
  let s = seed;
  const next = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < random; i++) {
    let t = "";
    const n = 1 + Math.floor(next() * 40);
    for (let k = 0; k < n; k++) {
      const r = next();
      t +=
        r < 0.55
          ? String.fromCharCode(32 + Math.floor(next() * 95))
          : r < 0.75
            ? String.fromCodePoint(0xa0 + Math.floor(next() * 0x2000))
            : r < 0.85
              ? String.fromCodePoint(0x1f300 + Math.floor(next() * 0x300))
              : r < 0.95
                ? (["<|s|>", "<|e|>", "<|x|>", "hello", " world", "über"][
                    Math.floor(next() * 6)
                  ] as string)
                : String.fromCharCode(Math.floor(next() * 32));
    }
    texts.push(t);
  }
  return texts;
}

function same(reference: Reference, mine: CompactTokenizer, texts: readonly string[]): string[] {
  const differ: string[] = [];
  for (const t of texts) {
    const a = reference.encode(t).ids;
    const b = mine.encode(t);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) differ.push(t.slice(0, 80));
  }
  return differ;
}

describe("CompactTokenizer, tiny model", () => {
  const json = tinyTokenizerJson();
  const reference = new Tokenizer(json, {}) as unknown as Reference;
  const mine = new CompactTokenizer(deriveTokenizer(json, TINY_SPLIT_PATTERN));

  it("the tiny model's split pattern is the library's translation of its regex", () => {
    const p = reference.pre_tokenizer.tokenizers[0]?.pattern as RegExp;
    expect({ source: p.source, flags: p.flags }).toEqual({ ...TINY_SPLIT_PATTERN });
  });

  it("cuts like @huggingface/tokenizers", () => {
    expect(same(reference, mine, edgeTexts(1782, 3000))).toEqual([]);
  });

  it("merges by rank, drops bytes without a token, wraps the template", () => {
    const ids = mine.encode("hello\u0001");
    expect(ids.length).toBe(3);
    expect(ids).toEqual(reference.encode("hello\u0001").ids);
  });

  it("refuses a pipeline it would not reproduce", () => {
    const withNormalizer = { ...json, normalizer: { type: "NFC" } };
    expect(() => deriveTokenizer(withNormalizer, TINY_SPLIT_PATTERN)).toThrow(
      "a normalizer is set",
    );
    const model = json.model as Record<string, unknown>;
    expect(() =>
      deriveTokenizer({ ...json, model: { ...model, ignore_merges: false } }, TINY_SPLIT_PATTERN),
    ).toThrow("ignore_merges");
    expect(() =>
      deriveTokenizer({ ...json, model: { ...model, merges: [["h", "zz"]] } }, TINY_SPLIT_PATTERN),
    ).toThrow("merge 0 names a token outside the vocabulary");
  });

  it("refuses a file that is not one", () => {
    expect(() => new CompactTokenizer(new Uint8Array(12))).toThrow("not a compact tokenizer");
  });
});

const model = embeddingModel(DEFAULT_EMBEDDING_MODEL_ID) as EmbeddingModel;
const { dir } = modelsForTests(model);
const publisherJson = dir ? modelFilePath(dir, model, model.files.tokenizer) : null;
// The publisher's tokenizer.json is in a checkout's models directory, not in an image's.
const real = publisherJson !== null && existsSync(publisherJson);

describe(`CompactTokenizer, ${model.id}`, () => {
  it.skipIf(!real)("the catalog's split pattern is the library's translation", () => {
    const json = JSON.parse(readFileSync(publisherJson as string, "utf8")) as object;
    const reference = new Tokenizer(json, {}) as unknown as Reference;
    const p = reference.pre_tokenizer.tokenizers[0]?.pattern as RegExp;
    expect({ source: p.source, flags: p.flags }).toEqual({ ...model.derived.splitPattern });
  });

  it.skipIf(!real)(
    "cuts this repository's documentation and edge cases like the library",
    () => {
      const json = JSON.parse(readFileSync(publisherJson as string, "utf8")) as object;
      const reference = new Tokenizer(json, {}) as unknown as Reference;
      const mine = new CompactTokenizer(
        readFileSync(modelFilePath(dir as string, model, model.derived.tokenizer)),
      );
      const texts: string[] = [];
      const walk = (path: string): void => {
        for (const name of readdirSync(path)) {
          if (name === "node_modules" || name.startsWith(".")) continue;
          const child = join(path, name);
          if (statSync(child).isDirectory()) walk(child);
          else if (name.endsWith(".md")) texts.push(...readFileSync(child, "utf8").split(/\n\n+/));
        }
      };
      walk(join(import.meta.dir, "../../../docs"));
      texts.push(...edgeTexts(1650, 2000));
      expect(texts.length).toBeGreaterThan(3000);
      expect(same(reference, mine, texts)).toEqual([]);
    },
    300_000,
  );
});

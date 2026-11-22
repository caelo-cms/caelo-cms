// SPDX-License-Identifier: MPL-2.0

/**
 * #1650 — the catalog's default model, loaded for real (see testing.ts for
 * when it runs): the JavaScript tokenizer cuts text exactly like the Rust
 * reference, and a text's vector is a function of that text alone, on
 * either runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModel, embeddingModel } from "@caelo-cms/shared";
import reference from "./__fixtures__/granite-embedding-97m-multilingual-r2.tokens.json";
import type { Embedder } from "./embedder.js";
import { readModelFiles } from "./files.js";
import { createNativeEmbedder } from "./native.js";
import { modelsForTests } from "./testing.js";
import { ModelTokenizer } from "./tokenize.js";
import { createWasmEmbedder } from "./wasm.js";

const model = embeddingModel(DEFAULT_EMBEDDING_MODEL_ID) as EmbeddingModel;
const { dir, required } = modelsForTests(model);
const live = (name: string, fn: () => Promise<void>) => it.skipIf(dir === null)(name, fn, 120_000);

let native: Embedder;
let wasm: Embedder;
let tokenizer: ModelTokenizer;

beforeAll(async () => {
  if (dir === null) return;
  tokenizer = new ModelTokenizer(model, (await readModelFiles(dir, model)).tokenizer);
  native = await createNativeEmbedder(model, { dir, threads: 2 });
  wasm = await createWasmEmbedder(model, { dir });
});
afterAll(async () => {
  await native?.release();
  await wasm?.release();
});

const dot = (a: Float32Array, b: Float32Array) =>
  a.reduce((s, x, i) => s + x * (b[i] as number), 0);

describe(`${model.id}, loaded`, () => {
  if (required) {
    it("the model is fetched (CAELO_MODELS=required)", () => {
      expect(dir).not.toBeNull();
    });
  }

  live("tokenizes like the Rust reference", async () => {
    expect(model.id).toBe("granite-embedding-97m-multilingual-r2");
    reference.texts.forEach((text, i) => {
      expect(tokenizer.encode(text, "query").ids).toEqual(reference.ids[i] as number[]);
    });
  });

  live("cuts a long text to maxTokens and keeps the closing token", async () => {
    const long = tokenizer.encode("Wort ".repeat(2000), "passage").ids;
    const short = tokenizer.encode("Wort", "passage").ids;
    expect(long.length).toBe(model.maxTokens);
    expect(long[0]).toBe(short[0] as number);
    expect(long[long.length - 1]).toBe(short[short.length - 1] as number);
  });

  live("gives unit vectors of the catalog's dimensions", async () => {
    const [v] = await native.embed(["Preise und Pakete"], "passage");
    expect(v?.length).toBe(model.dims);
    expect(Math.abs(dot(v as Float32Array, v as Float32Array) - 1)).toBeLessThan(1e-5);
    expect(native.fingerprint).toBe(`${model.id}@${model.files.model.sha256.slice(0, 12)}`);
  });

  live("a vector depends on its text alone, not on the texts embedded with it", async () => {
    const texts = [
      "Versandkosten ab 50 Euro",
      "Der Leseausweis kostet 15 Euro im Jahr, für Kinder ist er kostenlos.",
      "x",
    ];
    const together = await native.embed(texts, "passage");
    for (const [i, t] of texts.entries()) {
      const [alone] = await native.embed([t], "passage");
      expect([...(alone as Float32Array)]).toEqual([...(together[i] as Float32Array)]);
    }
    const again = await native.embed(texts, "passage");
    expect(again.map((v) => [...v])).toEqual(together.map((v) => [...v]));
  });

  live("native and WebAssembly agree within the quantisation's noise", async () => {
    const texts = [
      "Was kostet das Agenturpaket?",
      "Wie lange dauert ein neuer Reisepass?",
      "lost ID card",
      "Ab 50 € Bestellwert ist der Versand kostenlos, darunter berechnen wir 4,95 €.",
    ];
    const a = await native.embed(texts, "query");
    const b = await wasm.embed(texts, "query");
    for (let i = 0; i < texts.length; i++) {
      // bench/semantic-results.md: mean 0.9986, worst 0.978 on the labelled set.
      expect(dot(a[i] as Float32Array, b[i] as Float32Array)).toBeGreaterThan(0.97);
    }
  });
});

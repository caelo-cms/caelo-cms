// SPDX-License-Identifier: MPL-2.0

/**
 * #1650 — the parity test: passages embedded natively (the index job) and
 * queries embedded as WebAssembly (the gateway) meet in one index and find
 * the same pages a single runtime would, on the labelled German/English
 * set the default model was chosen by (bench/semantic-results.md). It also
 * keeps that choice honest: the hybrid ranking must stay well above the
 * word search alone, across languages too. Runs when the model is fetched
 * (packages/models testing.ts); CI requires it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Embedder, modelsForTests } from "@caelo-cms/models";
import { createNativeEmbedder } from "@caelo-cms/models/native";
import { createWasmEmbedder } from "@caelo-cms/models/wasm";
import { DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModel, embeddingModel } from "@caelo-cms/shared";
import { type Evaluation, evaluate } from "../bench/semantic-eval.js";

const model = embeddingModel(DEFAULT_EMBEDDING_MODEL_ID) as EmbeddingModel;
const { dir, required } = modelsForTests(model);

let result: Evaluation;
let native: Embedder;
let wasm: Embedder;

beforeAll(async () => {
  if (dir === null) return;
  native = await createNativeEmbedder(model, { dir, threads: 2 });
  wasm = await createWasmEmbedder(model, { dir });
  result = await evaluate(native, wasm);
}, 300_000);
afterAll(async () => {
  await native?.release();
  await wasm?.release();
});

const live = (name: string, fn: () => void) => it.skipIf(dir === null)(name, fn);

describe(`semantic search parity, ${model.id}`, () => {
  if (required) {
    it("the model is fetched (CAELO_MODELS=required)", () => {
      expect(dir).not.toBeNull();
    });
  }

  live("query vectors agree across runtimes within the quantisation's noise", () => {
    expect(result.parity.minCos).toBeGreaterThan(0.97);
    expect(result.parity.meanCos).toBeGreaterThan(0.995);
  });

  live("both runtimes' queries rank the same pages", () => {
    expect(result.parity.top1Agree).toBeGreaterThanOrEqual(0.95);
    expect(result.parity.overlap5).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(result.exact.all.mrr - result.crossRuntime.all.mrr)).toBeLessThan(0.02);
  });

  live("the hybrid ranking beats the word search, also across languages", () => {
    // Measured: lexical 0.66, hybrid 0.90 (cross-language 0.22 and 0.87).
    expect(result.engineHybrid.all.mrr).toBeGreaterThan(0.85);
    expect(result.engineHybrid.all.mrr - result.engineLexical.all.mrr).toBeGreaterThan(0.15);
    expect(result.engineHybrid.cross.mrr).toBeGreaterThan(0.8);
    // Words the page itself uses keep their exact answer.
    expect(result.engineHybrid.lexical.r1).toBe(1);
  });
});

// SPDX-License-Identifier: MPL-2.0

/** #1650 — the embedding-model catalog holds only what may ship. */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_IDS,
  EMBEDDING_MODELS,
  embeddingModel,
  embeddingModelFingerprint,
} from "./embedding-models.js";

describe("embedding-model catalog", () => {
  it("has unique ids and a default from the catalog", () => {
    expect(new Set(EMBEDDING_MODEL_IDS).size).toBe(EMBEDDING_MODELS.length);
    expect(embeddingModel(DEFAULT_EMBEDDING_MODEL_ID)).toBeDefined();
    expect(embeddingModel("jina-embeddings-v3")).toBeUndefined();
  });

  for (const m of EMBEDDING_MODELS) {
    it(`${m.id}: licence, pins and shape`, () => {
      // CLAUDE.md §3: MIT or Apache-2.0 only.
      expect(["MIT", "Apache-2.0"]).toContain(m.licence);
      expect(m.id).toMatch(/^[a-z0-9][a-z0-9.-]{0,79}$/);
      expect(m.source.revision).toMatch(/^[0-9a-f]{40}$/);
      for (const f of [m.files.model, m.files.tokenizer]) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.name).toMatch(/^[a-z_]+\.(onnx|json)$/);
      }
      expect(m.dims % 32).toBe(0);
      expect(m.maxTokens).toBeGreaterThan(16);
      expect(embeddingModelFingerprint(m)).toBe(`${m.id}@${m.files.model.sha256.slice(0, 12)}`);
    });
  }
});

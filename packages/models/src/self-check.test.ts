// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { EMBEDDING_MODELS, type EmbeddingModel } from "@caelo-cms/shared";
import type { Embedder } from "./embedder.js";
import { checkEmbedders, type EmbedderFactory } from "./self-check.js";

const [model] = EMBEDDING_MODELS as [EmbeddingModel];

/** A fake runtime answering `vector` for the probe. */
function runtime(vector: () => Float32Array, released: string[] = []): EmbedderFactory {
  return async (m) =>
    ({
      model: m,
      fingerprint: "test",
      embed: async () => [vector()],
      release: async () => {
        released.push(m.id);
      },
    }) as Embedder;
}

const unit = (i: number) => {
  const v = new Float32Array(model.dims);
  v[i] = 1;
  return v;
};

describe("checkEmbedders", () => {
  it("passes two runtimes that agree, and releases every embedder", async () => {
    const released: string[] = [];
    const report = await checkEmbedders(
      { wasm: runtime(() => unit(0), released), native: runtime(() => unit(0), released) },
      [model],
    );
    expect(report).toEqual({
      ok: true,
      checks: [
        { runtime: "wasm", model: model.id, ok: true },
        { runtime: "native", model: model.id, ok: true },
      ],
    });
    expect(released).toEqual([model.id, model.id]);
  });

  it("reports a runtime that cannot load, and still checks the other", async () => {
    const report = await checkEmbedders(
      {
        wasm: async () => {
          throw new Error("Cannot find module './ort-wasm-simd-threaded.mjs'");
        },
        native: runtime(() => unit(0)),
      },
      [model],
    );
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      {
        runtime: "wasm",
        model: model.id,
        ok: false,
        error: "Cannot find module './ort-wasm-simd-threaded.mjs'",
      },
      { runtime: "native", model: model.id, ok: true },
    ]);
  });

  it("refuses a vector of the wrong size, a non-finite one and an all-zero one", async () => {
    const report = await checkEmbedders(
      {
        short: runtime(() => new Float32Array(model.dims - 1).fill(1)),
        nan: runtime(() => {
          const v = unit(0);
          v[1] = Number.NaN;
          return v;
        }),
        zero: runtime(() => new Float32Array(model.dims)),
      },
      [model],
    );
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.error)).toEqual([
      `${model.dims - 1} dimensions, the catalog says ${model.dims}`,
      "the vector holds a non-finite value",
      "the vector is all zeros",
    ]);
  });

  it("fails runtimes that disagree on the probe", async () => {
    const report = await checkEmbedders(
      { wasm: runtime(() => unit(0)), native: runtime(() => unit(1)) },
      [model],
    );
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toEqual({
      runtime: "wasm~native",
      model: model.id,
      ok: false,
      error: "the runtimes disagree on the probe (cosine 0.0000, at least 0.99)",
    });
  });

  it("is not ok when nothing was checked", async () => {
    expect(await checkEmbedders({}, [model])).toEqual({ ok: false, checks: [] });
  });
});

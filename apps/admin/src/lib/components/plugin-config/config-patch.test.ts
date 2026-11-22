// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { configPatch, setAt, valueAt } from "./config-patch.js";

describe("configPatch", () => {
  const leaves = [
    { path: "results", type: "int" },
    { path: "ranking.mode", type: "enum" },
    { path: "ranking.weights", type: "map" },
  ];
  const before = { results: 10, ranking: { mode: "words", weights: { product: 2, doc: 1 } } };

  it("sends only what changed, nested, with removed map keys as null", () => {
    const after = structuredClone(before) as Record<string, unknown>;
    setAt(after, "ranking.mode", "hybrid");
    setAt(after, "ranking.weights", { product: 3, news: 1 });
    expect(configPatch(leaves, before, after)).toEqual({
      ranking: { mode: "hybrid", weights: { product: 3, news: 1, doc: null } },
    });
  });

  it("sends nothing for an unchanged form", () => {
    expect(configPatch(leaves, before, structuredClone(before))).toEqual({});
  });

  it("reads and writes dotted paths", () => {
    const v: Record<string, unknown> = {};
    setAt(v, "a.b.c", 1);
    expect(valueAt(v, "a.b.c")).toBe(1);
    expect(valueAt(v, "a.x")).toBeUndefined();
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs — pure tree helpers (ancestor chains, subtrees,
 * loud failure on cycles and dangling parents).
 */

import { describe, expect, it } from "bun:test";
import {
  ancestorIdsOf,
  ancestorSlugsOf,
  descendantIdsOf,
  indexTree,
  type PageTreeNode,
  subtreeHeight,
} from "./page-tree.js";

function tree(nodes: [string, string, string | null][]) {
  return indexTree(
    new Map<string, PageTreeNode>(
      nodes.map(([id, slug, parentPageId]) => [id, { id, slug, parentPageId, chatBranchId: null }]),
    ),
  );
}

const t = tree([
  ["a", "seo-monitoring", null],
  ["b", "alerts", "a"],
  ["c", "email", "b"],
  ["d", "pricing", null],
]);

describe("page tree", () => {
  it("ancestor chain root first", () => {
    expect(ancestorIdsOf(t, "c")).toEqual(["a", "b"]);
    expect(ancestorSlugsOf(t, "c")).toEqual(["seo-monitoring", "alerts"]);
    expect(ancestorIdsOf(t, "d")).toEqual([]);
  });

  it("descendants parents first, excluding the roots", () => {
    expect(descendantIdsOf(t, ["a"])).toEqual(["b", "c"]);
    expect(descendantIdsOf(t, ["d"])).toEqual([]);
    expect(subtreeHeight(t, "a")).toBe(3);
  });

  it("cycles and dangling parents fail loudly", () => {
    const cyc = tree([
      ["x", "x", "y"],
      ["y", "y", "x"],
    ]);
    expect(() => ancestorIdsOf(cyc, "x")).toThrow(/cycle/);
    const dangling = tree([["x", "x", "gone"]]);
    expect(() => ancestorIdsOf(dangling, "x")).toThrow(/move_pages/);
  });
});

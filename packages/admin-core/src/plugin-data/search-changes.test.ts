// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type PlannedSearchChange, searchChangesForTarget } from "./build.js";

const FP = (c: string) => c.repeat(64);
const change = (pageId: string, pluginFingerprint: string): PlannedSearchChange => ({
  pageId,
  url: `https://example.com/${pageId}/`,
  title: `Page ${pageId}`,
  summary: "",
  pluginFingerprint,
  firstPublishedAt: "2026-11-01T00:00:00.000Z",
});

describe("searchChangesForTarget (docs/dev/search-engine-feed.md)", () => {
  it("a second target serving the same build ships the entries the first one recorded", () => {
    const across = new Map<string, PlannedSearchChange>();
    // The first target finds the change in the record and records it…
    expect(
      searchChangesForTarget(
        [change("a", FP("b"))],
        [{ pageId: "a", pluginFingerprint: FP("b") }],
        across,
      ),
    ).toEqual([change("a", FP("b"))]);
    // …so the plan for the second finds none, but its copy needs it too.
    expect(
      searchChangesForTarget([], [{ pageId: "a", pluginFingerprint: FP("b") }], across),
    ).toEqual([change("a", FP("b"))]);
  });

  it("a target whose copy baked something else does not take another target's change", () => {
    const across = new Map([["a", change("a", FP("b"))]]);
    expect(
      searchChangesForTarget([], [{ pageId: "a", pluginFingerprint: FP("c") }], across),
    ).toEqual([]);
    expect(searchChangesForTarget([], [], across)).toEqual([]);
  });
});

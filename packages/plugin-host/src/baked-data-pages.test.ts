// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PluginBakedData } from "@caelo-cms/plugin-sdk";
import { bakedDataPageIds, MAX_BAKED_PAGES_PER_CALL } from "./baked-data-pages.js";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";

const DECL: PluginBakedData = {
  description: "Approved comments.",
  triggers: [
    { operation: "moderate", pageIds: { from: "result", key: "pageId" } },
    { operation: "bulk_moderate", pageIds: { from: "result", key: "pageIds" } },
    { operation: "vote", pageIds: { from: "args", key: "pageId" } },
  ],
};

describe("bakedDataPageIds (#1155)", () => {
  it("reads one id or a list from the declared key of the result or the args", () => {
    expect(bakedDataPageIds(DECL, "moderate", { args: {}, result: { pageId: A } })).toEqual([A]);
    expect(
      bakedDataPageIds(DECL, "bulk_moderate", {
        args: {},
        result: { pageIds: [A, B, A.toUpperCase()] },
      }),
    ).toEqual([A, B]);
    expect(bakedDataPageIds(DECL, "vote", { args: { pageId: B }, result: null })).toEqual([B]);
  });

  it("an operation that is not a declared trigger names no page", () => {
    expect(
      bakedDataPageIds(DECL, "submit", { args: { pageId: A }, result: { pageId: A } }),
    ).toEqual([]);
    expect(bakedDataPageIds(undefined, "moderate", { args: {}, result: { pageId: A } })).toEqual(
      [],
    );
  });

  it("a value that is not a page id (or a list of them) names nothing", () => {
    for (const result of [
      { pageId: "page-1" },
      { pageId: 42 },
      { pageIds: [A, "x"] },
      null,
      [A],
      "nope",
    ]) {
      expect(bakedDataPageIds(DECL, "moderate", { args: {}, result })).toEqual([]);
      expect(bakedDataPageIds(DECL, "bulk_moderate", { args: {}, result })).toEqual([]);
    }
  });

  it("caps a list, and the gateway's single mode takes exactly one id", () => {
    const many = Array.from({ length: MAX_BAKED_PAGES_PER_CALL + 1 }, () => A);
    expect(
      bakedDataPageIds(DECL, "bulk_moderate", { args: {}, result: { pageIds: many } }),
    ).toEqual([]);
    const two = { args: {}, result: { pageIds: [A, B] } };
    expect(bakedDataPageIds(DECL, "bulk_moderate", two, { single: true })).toEqual([]);
    expect(
      bakedDataPageIds(DECL, "vote", { args: { pageId: A }, result: {} }, { single: true }),
    ).toEqual([A]);
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  STRUCTURED_DATA_PAGES_PER_CALL,
  type StructuredDataArgs,
  type StructuredDataPage,
} from "@caelo-cms/plugin-sdk";
import { COMPOSITION_CALL_ARGS_BYTES, compositionCalls } from "./composition-calls.js";
import { SANDBOX_MESSAGE_BYTES } from "./sandbox-protocol.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

function page(n: number, over: Partial<StructuredDataPage> = {}): StructuredDataPage {
  return {
    pageId: id(n),
    pageType: "article",
    path: `/p${n}`,
    isHome: false,
    lang: "en",
    title: `Page ${n}`,
    shortTitle: `P${n}`,
    description: "",
    shareImage: null,
    live: true,
    publishedAt: null,
    properties: {},
    terms: [],
    propertyTerms: [],
    listed: [],
    ...over,
  };
}

function input(
  pages: StructuredDataPage[],
  related: StructuredDataPage[] = [],
): StructuredDataArgs {
  return {
    pages,
    related,
    pageTypes: { article: { properties: [{ name: "body", type: "richtext" }] } },
    site: { organization: true, name: "Blog" },
  };
}

describe("compositionCalls (#1753, #1761; Codex on #1797)", () => {
  it("keeps a call's arguments within one sandbox message, with room for the envelope", () => {
    expect(COMPOSITION_CALL_ARGS_BYTES).toBe(SANDBOX_MESSAGE_BYTES - 64 * 1024);
    // 50 pages of two 20,000-character properties: about 2 MB in one call before.
    const long = "x".repeat(20_000);
    const pages = Array.from({ length: 50 }, (_, i) =>
      page(i, { properties: { body: long, summary: long } }),
    );
    const { calls, oversized } = compositionCalls(input(pages));
    expect(oversized).toEqual([]);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(bytes(c.args)).toBeLessThanOrEqual(COMPOSITION_CALL_ARGS_BYTES);
    // Every page asked once, in order.
    expect(calls.flatMap((c) => c.pages.map((p) => p.pageId))).toEqual(pages.map((p) => p.pageId));
  });

  it("still cuts by count when the pages are small", () => {
    const pages = Array.from({ length: 120 }, (_, i) => page(i));
    const { calls } = compositionCalls(input(pages));
    expect(calls.map((c) => c.pages.length)).toEqual([
      STRUCTURED_DATA_PAGES_PER_CALL,
      STRUCTURED_DATA_PAGES_PER_CALL,
      120 - 2 * STRUCTURED_DATA_PAGES_PER_CALL,
    ]);
  });

  it("counts the pages a page names: a large author moves the next article to a new call", () => {
    const author = page(900, { pageType: "author", properties: { bio: "b".repeat(6_000) } });
    const pages = Array.from({ length: 4 }, (_, i) =>
      page(i, {
        properties: { authors: [`caelo:page/${author.pageId}`], body: "y".repeat(3_000) },
      }),
    );
    const max = 20_000;
    const { calls } = compositionCalls(input(pages, [author]), max);
    for (const c of calls) {
      expect(bytes(c.args)).toBeLessThanOrEqual(max);
      expect(c.args.related.map((r) => r.pageId)).toEqual([author.pageId]);
    }
    expect(calls.flatMap((c) => c.pages).length).toBe(4);
  });

  it("names a page too large for any call instead of dropping it, and asks about the rest", () => {
    const huge = page(1, { properties: { body: "z".repeat(30_000) } });
    const { calls, oversized } = compositionCalls(input([page(0), huge, page(2)]), 20_000);
    expect(oversized.map((p) => p.pageId)).toEqual([huge.pageId]);
    expect(calls.flatMap((c) => c.pages.map((p) => p.pageId))).toEqual([id(0), id(2)]);
  });
});

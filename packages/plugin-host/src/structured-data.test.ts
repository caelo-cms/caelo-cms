// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { StructuredDataArgs, StructuredDataPage } from "@caelo-cms/plugin-sdk";
import { chunkArgs } from "./composition-calls.js";

const ARTICLE = "11111111-1111-4111-8111-111111111111";
const ANNA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function page(pageId: string, over: Partial<StructuredDataPage> = {}): StructuredDataPage {
  return {
    pageId,
    pageType: "author",
    path: `/${pageId.slice(0, 4)}`,
    isHome: false,
    lang: "en",
    title: pageId,
    shortTitle: pageId,
    description: "Its own description",
    shareImage: null,
    live: true,
    publishedAt: "2026-01-01T00:00:00.000Z",
    properties: {},
    terms: [],
    propertyTerms: [],
    listed: [],
    ...over,
  };
}

describe("chunkArgs (#1753)", () => {
  const article = page(ARTICLE, {
    pageType: "article",
    properties: { authors: [`caelo:page/${ANNA}`, `caelo:page/${BEN}`] },
  });
  const input: StructuredDataArgs = {
    pages: [article, page(ANNA), page(OTHER)],
    related: [page(BEN, { lang: "", description: "", live: false })],
    pageTypes: { article: { properties: [] }, author: { properties: [] } },
    site: { organization: true, name: "Blog" },
  };

  it("hands an author asked about in another chunk to the article's call, without its head", () => {
    const args = chunkArgs(input, [article]);
    expect(args.pages.map((p) => p.pageId)).toEqual([ARTICLE]);
    expect(args.related.map((p) => p.pageId).sort()).toEqual([ANNA, BEN]);
    const anna = args.related.find((p) => p.pageId === ANNA);
    expect(anna).toMatchObject({ title: ANNA, description: "", lang: "", live: false, listed: [] });
    expect(Object.keys(args.pageTypes).sort()).toEqual(["article", "author"]);
  });

  it("names no page of the chunk itself as related, and no page nobody names", () => {
    const args = chunkArgs(input, [article, page(ANNA)]);
    expect(args.related.map((p) => p.pageId)).toEqual([BEN]);
    expect(chunkArgs(input, [page(OTHER)]).related).toEqual([]);
  });
});

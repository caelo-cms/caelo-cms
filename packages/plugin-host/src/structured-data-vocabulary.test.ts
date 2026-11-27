// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  STRUCTURED_DATA_ARRAY_MAX,
  STRUCTURED_DATA_NODES_PER_PAGE,
  STRUCTURED_DATA_TEXT_MAX,
} from "@caelo-cms/plugin-sdk";
import { checkStructuredDataAnswer } from "./structured-data-vocabulary.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const asked = new Set([PAGE]);

/** The refusals of an answer whose one node has `properties`. */
function refusalsOf(properties: Record<string, unknown>) {
  return checkStructuredDataAnswer(
    { pages: { [PAGE]: { nodes: [{ type: "Article", id: { fragment: "a" }, properties }] } } },
    asked,
  ).refusals.map((r) => `${r.field}:${r.rule}`);
}

describe("structured-data vocabulary (#1753)", () => {
  it("accepts every value kind of the vocabulary", () => {
    const r = checkStructuredDataAnswer(
      {
        pages: {
          [PAGE]: {
            webPage: {
              type: "ProfilePage",
              properties: {
                mainEntity: { ref: { fragment: "person" } },
                lastReviewed: { date: "2026-11-02" },
              },
            },
            nodes: [
              {
                type: ["Person"],
                id: { fragment: "person" },
                properties: {
                  name: "Anna Berg — SEO < 1 year",
                  url: { page: PAGE },
                  image: { media: OTHER },
                  sameAs: [{ url: "https://www.linkedin.com/in/anna" }],
                  worksFor: { ref: "organization" },
                  knowsAbout: ["SEO", "Structured data"],
                  birthDate: { date: "1990-02-28" },
                  height: 1.7,
                  isFamilyFriendly: true,
                  homeLocation: {
                    node: {
                      type: "Place",
                      properties: {
                        address: {
                          node: { type: "PostalAddress", properties: { addressLocality: "Köln" } },
                        },
                      },
                    },
                  },
                },
              },
              {
                type: "VideoObject",
                id: { page: OTHER, fragment: "video" },
                properties: {
                  duration: { duration: "PT4M13S" },
                  uploadDate: { live: "published" },
                  publication: { date: "2026-11-02T10:00:00+01:00" },
                  availability: { schema: "InStock" },
                },
              },
            ],
          },
        },
      },
      asked,
    );
    expect(r.refusals).toEqual([]);
    const page = r.pages.get(PAGE);
    expect(page?.webPageType).toBe("ProfilePage");
    expect(page?.nodes.map((n) => n.id)).toEqual([
      { page: null, fragment: "person" },
      { page: OTHER, fragment: "video" },
    ]);
  });

  it("refuses markup and a `</script>` in a text value", () => {
    expect(refusalsOf({ headline: "</script><script>alert(1)</script>" })).toEqual([
      "headline:text-markup",
    ]);
    expect(refusalsOf({ description: "<p>prose</p>" })).toEqual(["description:text-markup"]);
    expect(refusalsOf({ description: "a <!-- comment" })).toEqual(["description:text-markup"]);
  });

  it("refuses a free URL, to this site or any other, written as text", () => {
    expect(refusalsOf({ url: "https://example.com/team/anna/" })).toEqual(["url:text-url"]);
    expect(refusalsOf({ url: "//evil.example/x" })).toEqual(["url:text-url"]);
    expect(refusalsOf({ url: "javascript:alert(1)" })).toEqual(["url:text-url"]);
    expect(refusalsOf({ sameAs: { url: "javascript:alert(1)" } })).toEqual(["sameAs:url-scheme"]);
    expect(refusalsOf({ sameAs: { url: "https://u:p@evil.example/" } })).toEqual([
      "sameAs:url-credentials",
    ]);
  });

  it("refuses an unknown type, on a node and on a nested node", () => {
    const unknown = checkStructuredDataAnswer(
      {
        pages: { [PAGE]: { nodes: [{ type: "Articel", id: { fragment: "a" }, properties: {} }] } },
      },
      asked,
    );
    expect(unknown.refusals).toEqual([{ pageId: PAGE, field: "type", rule: "type-unknown" }]);
    expect(unknown.pages.size).toBe(0);
    expect(refusalsOf({ address: { node: { type: "Adress", properties: {} } } })).toEqual([
      "address:type-unknown",
    ]);
    const webPage = checkStructuredDataAnswer(
      { pages: { [PAGE]: { webPage: { type: "Article" } } } },
      asked,
    );
    expect(webPage.refusals).toEqual([
      { pageId: PAGE, field: "webpage", rule: "type-not-webpage" },
    ]);
  });

  it("refuses a WebPage property core owns", () => {
    const r = checkStructuredDataAnswer(
      {
        pages: {
          [PAGE]: {
            webPage: {
              properties: {
                url: { page: PAGE },
                name: "x",
                reviewedBy: { ref: { fragment: "p" } },
              },
            },
          },
        },
      },
      asked,
    );
    expect(r.refusals.map((x) => `${x.field}:${x.rule}`)).toEqual([
      "url:property-not-allowed",
      "name:property-not-allowed",
    ]);
    expect([...(r.pages.get(PAGE)?.webPage.keys() ?? [])]).toEqual(["reviewedBy"]);
  });

  it("refuses an answer for a page that was not asked about, on every asked page", () => {
    const r = checkStructuredDataAnswer(
      { pages: { [OTHER]: { nodes: [{ type: "Thing", id: { fragment: "x" }, properties: {} }] } } },
      asked,
    );
    expect(r.refusals).toEqual([{ pageId: PAGE, field: "answer", rule: "page-not-asked" }]);
    expect(r.pages.size).toBe(0);
  });

  it("refuses an oversized page answer and too many nodes whole", () => {
    const big = checkStructuredDataAnswer(
      {
        pages: {
          [PAGE]: {
            nodes: Array.from({ length: 8 }, (_, i) => ({
              type: "Thing",
              id: { fragment: `n${i}` },
              properties: { description: "x".repeat(STRUCTURED_DATA_TEXT_MAX) },
            })),
          },
        },
      },
      asked,
    );
    expect(big.refusals).toEqual([{ pageId: PAGE, field: "page", rule: "page-too-large" }]);
    expect(big.pages.size).toBe(0);
    const many = checkStructuredDataAnswer(
      {
        pages: {
          [PAGE]: {
            nodes: Array.from({ length: STRUCTURED_DATA_NODES_PER_PAGE + 1 }, (_, i) => ({
              type: "Thing",
              id: { fragment: `n${i}` },
              properties: {},
            })),
          },
        },
      },
      asked,
    );
    expect(many.refusals).toEqual([{ pageId: PAGE, field: "page", rule: "nodes-over-limit" }]);
  });

  it("refuses core's ids, a node id twice and a bad fragment", () => {
    const r = checkStructuredDataAnswer(
      {
        pages: {
          [PAGE]: {
            nodes: [
              { type: "Organization", id: { fragment: "organization" }, properties: {} },
              { type: "Thing", id: { page: OTHER, fragment: "webpage" }, properties: {} },
              { type: "Thing", id: { fragment: "x" }, properties: {} },
              { type: "Thing", id: { fragment: "x" }, properties: {} },
              { type: "Thing", id: { fragment: "Bad Fragment" }, properties: {} },
              { type: "Thing", properties: {} },
            ],
          },
        },
      },
      asked,
    );
    expect(r.refusals.map((x) => `${x.field}:${x.rule}`)).toEqual([
      "id:id-reserved",
      "id:id-reserved",
      "id:id-taken",
      "id:fragment-invalid",
      "id:id-missing",
    ]);
    expect(r.pages.get(PAGE)?.nodes).toHaveLength(1);
  });

  it("refuses malformed values with the rule they break", () => {
    expect(
      refusalsOf({
        a: { date: "2026-02-30" },
        b: { duration: "4 minutes" },
        c: { live: "yesterday" },
        d: { page: "not-a-uuid" },
        e: { media: 7 },
        f: { schema: "in stock" },
        g: { ref: "everything" },
        h: [["nested"]],
        i: Array.from({ length: STRUCTURED_DATA_ARRAY_MAX + 1 }, () => "x"),
        j: Number.NaN,
        k: { html: "<b>x</b>" },
        l: null,
        m: { node: { node: { node: { node: { type: "Thing", properties: {} } } } } },
      }),
    ).toEqual([
      "a:date-format",
      "b:duration-format",
      "c:live-unknown",
      "d:page-id-invalid",
      "e:media-id-invalid",
      "f:schema-term",
      "g:ref-unknown",
      "h:array-nested",
      "i:array-too-long",
      "j:number-not-finite",
      "k:value-shape",
      "l:value-shape",
      "m:node-shape",
    ]);
  });

  it("refuses nesting past the depth cap", () => {
    const deep = (n: number): unknown =>
      n === 0 ? "leaf" : { node: { type: "Thing", properties: { inner: deep(n - 1) } } };
    expect(refusalsOf({ deep: deep(3) })).toEqual([]);
    expect(refusalsOf({ deep: deep(4) })).toEqual(["deep:inline-too-deep"]);
  });

  it("refuses an answer that is not `{pages}` for every asked page", () => {
    for (const raw of [null, [], { pages: [] }, { pages: {}, extra: 1 }, "x"]) {
      expect(checkStructuredDataAnswer(raw, asked).refusals).toEqual([
        { pageId: PAGE, field: "answer", rule: "answer-shape" },
      ]);
    }
  });
});

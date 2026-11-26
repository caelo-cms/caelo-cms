// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the head vocabulary every plugin's answer is held to
 * (docs/dev/external-plugin-brokers.md §6.2): what passes, and the rule
 * each refused part is named by.
 */

import { describe, expect, it } from "bun:test";
import { HEAD_ENTRIES_PER_PAGE } from "@caelo-cms/plugin-sdk";
import { checkHeadAnswer, headEntryRule } from "./head-vocabulary.js";

const P = "00000000-0000-4000-8000-000000000001";
const Q = "00000000-0000-4000-8000-000000000002";
const asked = new Set([P, Q]);
const check = (raw: unknown) => checkHeadAnswer(raw, asked, "test");
const alt = (hreflang: string, pageId = Q) => ({
  kind: "link",
  rel: "alternate",
  hreflang,
  pageId,
});

describe("#1729 — the head vocabulary", () => {
  it("accepts alternates by page id, og:locale, sitemap adjustments and a language", () => {
    const r = check({
      head: {
        [P]: [
          alt("de"),
          alt("x-default", P),
          { kind: "meta", property: "og:locale", content: "en_GB" },
          { kind: "meta", property: "og:locale:alternate", content: "de_DE" },
          { kind: "meta", property: "og:locale:alternate", content: "es_419" },
        ],
      },
      sitemap: { [P]: { exclude: false, alternates: [{ hreflang: "de", pageId: Q }] } },
      lang: { [P]: "en-GB" },
    });
    expect(r.refusals).toEqual([]);
    expect(r.head.get(P)).toHaveLength(5);
    expect(r.sitemap.get(P)).toEqual({ alternates: [{ hreflang: "de", pageId: Q }] });
    expect(r.lang.get(P)).toBe("en-GB");
  });

  it("names the rule of every refused link and meta", () => {
    const cases: [unknown, string, string][] = [
      [
        { kind: "link", rel: "stylesheet", href: "https://evil.example/x.css" },
        "link",
        "rel-stylesheet",
      ],
      [
        { kind: "link", rel: "preconnect", href: "https://tracker.example" },
        "link",
        "rel-preconnect",
      ],
      [{ kind: "link", rel: "canonical", pageId: Q }, "link", "rel-canonical"],
      [
        { kind: "link", rel: "alternate", hreflang: "de", href: "https://evil.example/de" },
        "link",
        "href-not-allowed",
      ],
      [{ ...alt("de"), media: "screen" }, "link", "attribute-media"],
      [{ kind: "link", rel: "alternate", pageId: Q }, "link", "hreflang-missing"],
      [alt('de"><script>alert(1)</script>'), "link", "hreflang-invalid"],
      [alt("de", "not-a-page"), "link", "page-id-invalid"],
      [{ kind: "meta", name: "robots", content: "noindex" }, "meta", "name-robots"],
      [{ kind: "meta", name: "referrer", content: "unsafe-url" }, "meta", "name-referrer"],
      [
        { kind: "meta", property: "og:image", content: "https://evil.example/i.png" },
        "meta",
        "property-og-image",
      ],
      [
        { kind: "meta", property: "og:locale", content: "javascript:alert(1)" },
        "meta",
        "content-format",
      ],
      [
        { kind: "meta", property: "og:locale", content: "<script>alert(1)</script>" },
        "meta",
        "content-format",
      ],
      [
        { kind: "meta", property: "og:locale", content: "de_DE", extra: 1 },
        "meta",
        "attribute-extra",
      ],
      [{ kind: "script", src: "https://evil.example/x.js" }, "entry", "kind-script"],
      ["<script>alert(1)</script>", "entry", "entry-shape"],
    ];
    for (const [raw, field, rule] of cases) {
      expect({ raw, ...headEntryRule(raw) }).toEqual({ raw, field, rule });
      const r = check({ head: { [P]: [raw, alt("de")] } });
      expect(r.refusals).toEqual([{ pageId: P, field, rule }]);
      // The rest of the page's entries stand.
      expect(r.head.get(P)).toEqual([alt("de")]);
    }
  });

  it(`refuses every head entry of a page with more than ${HEAD_ENTRIES_PER_PAGE}`, () => {
    const many = Array.from({ length: HEAD_ENTRIES_PER_PAGE + 1 }, (_, i) =>
      alt(`l${String.fromCharCode(97 + i)}`),
    );
    const r = check({
      head: { [P]: many, [Q]: many.slice(0, HEAD_ENTRIES_PER_PAGE) },
      sitemap: {
        [P]: { alternates: many.map(({ hreflang, pageId }) => ({ hreflang, pageId })) },
      },
    });
    expect(r.refusals).toEqual([
      { pageId: P, field: "entries", rule: "entries-over-limit" },
      { pageId: P, field: "sitemap", rule: "alternates-over-limit" },
    ]);
    expect(r.head.has(P)).toBe(false);
    expect(r.head.get(Q)).toHaveLength(HEAD_ENTRIES_PER_PAGE);
    expect(r.sitemap.has(P)).toBe(false);
  });

  it("refuses sitemap parts outside the vocabulary and a language that is no tag", () => {
    const r = check({
      sitemap: {
        [P]: {
          alternates: [
            { hreflang: "de", href: "https://evil.example/de" },
            { hreflang: "fr", pageId: Q },
          ],
        },
        [Q]: { priority: 1 },
      },
      lang: { [P]: 'en" onload="x' },
    });
    expect(r.refusals).toEqual([
      { pageId: P, field: "sitemap", rule: "href-not-allowed" },
      { pageId: Q, field: "sitemap", rule: "attribute-priority" },
      { pageId: P, field: "lang", rule: "lang-invalid" },
    ]);
    expect(r.sitemap.get(P)).toEqual({ alternates: [{ hreflang: "fr", pageId: Q }] });
    expect(r.lang.size).toBe(0);
  });

  it("an answer that is not {head?, sitemap?, lang?} is refused for every page asked", () => {
    for (const raw of [null, "head", [], { head: [] }, { head: {}, script: "x" }]) {
      expect(check(raw).refusals).toEqual([
        { pageId: P, field: "answer", rule: "answer-shape" },
        { pageId: Q, field: "answer", rule: "answer-shape" },
      ]);
    }
  });

  it("an answer for a page the call did not ask about throws", () => {
    expect(() => check({ head: { "00000000-0000-4000-8000-0000000000ff": [alt("de")] } })).toThrow(
      /not part of this call/,
    );
  });
});

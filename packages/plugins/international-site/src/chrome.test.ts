// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  applyStrings,
  buildChromeTranslationPrompt,
  chromeTranslationJsonSchema,
  chromeTranslationPayload,
  sourceFingerprint,
  translatableStrings,
  validateChromeTranslation,
} from "./chrome.js";

const fields = [
  { name: "tagline", kind: "text" },
  { name: "nav", kind: "link-list" },
  { name: "tags", kind: "text-list" },
  { name: "cta_href", kind: "url" },
  { name: "count", kind: "number" },
];
const values = {
  tagline: "Made with care",
  nav: [
    { label: "About", href: "/about" },
    { label: "Pricing", href: "/pricing/?ref=nav#top" },
  ],
  tags: ["fast", ""],
  cta_href: "/contact",
  count: 3,
};

describe("translatableStrings", () => {
  it("collects text, list items and link labels — never addresses or numbers", () => {
    expect(translatableStrings(fields, values)).toEqual([
      { path: "tagline", text: "Made with care" },
      { path: "nav[0].label", text: "About" },
      { path: "nav[1].label", text: "Pricing" },
      { path: "tags[0]", text: "fast" },
    ]);
    expect(translatableStrings([{ name: "logo", kind: "image" }], { logo: "x.png" })).toEqual([]);
  });
});

describe("applyStrings", () => {
  it("writes translations into a copy, keeping hrefs and other values", () => {
    const out = applyStrings(values, {
      tagline: "Mit Sorgfalt",
      "nav[0].label": "Über uns",
      "tags[0]": "schnell",
    });
    expect(out.tagline).toBe("Mit Sorgfalt");
    expect(out.nav).toEqual([
      { label: "Über uns", href: "/about" },
      { label: "Pricing", href: "/pricing/?ref=nav#top" },
    ]);
    expect(out.tags).toEqual(["schnell", ""]);
    expect(values.tagline).toBe("Made with care");
  });

  it("refuses paths the source does not have", () => {
    expect(() => applyStrings(values, { "nav[9].label": "x" })).toThrow(/no list item/);
    expect(() => applyStrings(values, { count: "x" })).toThrow(/no text/);
    expect(() => applyStrings(values, { "a]b": "x" })).toThrow(/malformed/);
  });
});

describe("sourceFingerprint", () => {
  it("is stable under key order and changes with content", () => {
    const a = sourceFingerprint(fields, { tagline: "x", nav: [] });
    expect(sourceFingerprint(fields, { nav: [], tagline: "x" })).toBe(a);
    expect(sourceFingerprint(fields, { nav: [], tagline: "y" })).not.toBe(a);
  });
});

describe("chrome translation contract", () => {
  const targets = [
    { id: "c0", label: "Footer", strings: [{ path: "tagline", text: "Made with care" }] },
    { id: "c1", label: "Menu", strings: [{ path: "nav[0].label", text: "About" }] },
  ];

  it("prompts with every target and path", () => {
    const { system, user } = buildChromeTranslationPrompt({
      sourceLocale: "en",
      targetLocale: "de",
      targetLocaleDisplayName: "Deutsch",
      targets,
      glossaryBlock: "",
      styleGuideBlock: "",
    });
    expect(system).toContain("Target locale: de (Deutsch)");
    expect(user).toContain("### Target c0 (Footer)");
    expect(user).toContain("nav[0].label:\n```\nAbout\n```");
  });

  it("accepts exactly the offered targets and paths", () => {
    const ok = {
      targets: [
        { target: "c0", strings: { tagline: "Mit Sorgfalt" } },
        { target: "c1", strings: { "nav[0].label": "Über uns" } },
      ],
    };
    expect(() => validateChromeTranslation(ok, targets)).not.toThrow();
    expect(() => validateChromeTranslation({ targets: [ok.targets[0] as never] }, targets)).toThrow(
      /missing target c1/,
    );
    expect(() =>
      validateChromeTranslation(
        { targets: [...ok.targets, { target: "c9", strings: {} }] },
        targets,
      ),
    ).toThrow(/not offered/);
    expect(() =>
      validateChromeTranslation(
        { targets: [{ target: "c0", strings: {} }, ok.targets[1] as never] },
        targets,
      ),
    ).toThrow(/missing path/);
  });

  it("builds the structured-output schema from exactly the offered targets and paths (#992)", () => {
    const schema = chromeTranslationJsonSchema(targets) as {
      required: string[];
      additionalProperties: boolean;
      properties: { targets: { items: { anyOf: Record<string, unknown>[] } } };
    };
    expect(schema.required).toEqual(["targets"]);
    expect(schema.additionalProperties).toBe(false);
    const variants = schema.properties.targets.items.anyOf as Array<{
      additionalProperties: boolean;
      required: string[];
      properties: {
        target: { enum: string[] };
        strings: { required: string[]; additionalProperties: boolean; properties: object };
      };
    }>;
    expect(variants.map((v) => v.properties.target.enum)).toEqual([["c0"], ["c1"]]);
    expect(variants.map((v) => v.properties.strings.required)).toEqual([
      ["tagline"],
      ["nav[0].label"],
    ]);
    for (const v of variants) {
      expect(v.additionalProperties).toBe(false);
      expect(v.required).toEqual(["target", "strings"]);
      expect(v.properties.strings.additionalProperties).toBe(false);
    }
    // Every object the decoder sees closes its properties.
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.type === "object") expect(o.additionalProperties).toBe(false);
      for (const child of Object.values(o)) {
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    };
    walk(schema);
  });

  it("an answer that fits the schema passes the same Zod contract and validator", () => {
    const answer = {
      targets: [
        { target: "c0", strings: { tagline: "Mit Sorgfalt" } },
        { target: "c1", strings: { "nav[0].label": "Über uns" } },
      ],
    };
    const parsed = chromeTranslationPayload.parse(answer);
    expect(() => validateChromeTranslation(parsed, targets)).not.toThrow();
  });
});

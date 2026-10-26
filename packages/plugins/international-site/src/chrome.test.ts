// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ListTypeDef } from "@caelo-cms/plugin-sdk";
import {
  applyStrings,
  buildChromeTranslationPrompt,
  chromeTranslationJsonSchema,
  chromeTranslationPayload,
  sourceFingerprint,
  translatableStrings,
  validateChromeTranslation,
} from "./chrome.js";

const E1 = "00000000-0000-4000-9000-000000000001";
const E2 = "00000000-0000-4000-9000-000000000002";
const T1 = "00000000-0000-4000-9000-000000000003";
const T2 = "00000000-0000-4000-9000-000000000004";

const fields = [
  { name: "tagline", kind: "text" },
  { name: "nav", kind: "list", listType: "links" },
  { name: "tags", kind: "list", listType: "texts" },
  { name: "cta_href", kind: "url" },
  { name: "count", kind: "number" },
];
// The shipped `links` and `texts` types (shared default-types.ts).
const listTypes = new Map<string, ListTypeDef>([
  [
    "links",
    {
      slug: "links",
      name: "Links",
      purpose: "Links",
      role: "content",
      root: { allow: ["link"] },
      nodes: {
        link: {
          label: "Link",
          fields: [
            { name: "label", label: "Label", type: "text", required: true },
            { name: "link", label: "Link", type: "link", required: true },
          ],
        },
      },
    },
  ],
  [
    "texts",
    {
      slug: "texts",
      name: "Texts",
      purpose: "Texts",
      role: "content",
      root: { allow: ["text"] },
      nodes: {
        text: {
          label: "Text",
          fields: [{ name: "text", label: "Text", type: "text", required: true }],
        },
      },
    },
  ],
]);
const LAYOUT = { listTypes, includeLists: true };
const values = {
  tagline: "Made with care",
  nav: [
    { id: E1, node: "link", values: { label: "About", link: { href: "/about" } } },
    { id: E2, node: "link", values: { label: "Pricing", link: { href: "/pricing/?ref=nav#top" } } },
  ],
  tags: [
    { id: T1, node: "text", values: { text: "fast" } },
    { id: T2, node: "text", values: { text: "" } },
  ],
  cta_href: "/contact",
  count: 3,
};

describe("translatableStrings", () => {
  it("collects text, list items and link labels — never addresses or numbers", () => {
    expect(translatableStrings(fields, values, LAYOUT)).toEqual([
      { path: "tagline", text: "Made with care" },
      { path: `nav[${E1}].label`, text: "About" },
      { path: `nav[${E2}].label`, text: "Pricing" },
      { path: `tags[${T1}].text`, text: "fast" },
    ]);
    expect(
      translatableStrings([{ name: "logo", kind: "image" }], { logo: "x.png" }, LAYOUT),
    ).toEqual([]);
  });

  it("reads which entry fields are text from the list type, not from key names (#1114)", () => {
    // `title` was on the old heuristic key list; here it is a code field
    // the type marks as not translated, and `body` is rich text nobody
    // would have guessed.
    const type: ListTypeDef = {
      slug: "faq",
      name: "FAQ",
      purpose: "Questions",
      role: "content",
      root: { allow: ["qa"] },
      nodes: {
        qa: {
          label: "Q&A",
          fields: [
            {
              name: "title",
              label: "Code",
              type: "text",
              ext: { "international-site": { translate: false } },
            },
            { name: "body", label: "Answer", type: "richtext" },
          ],
        },
      },
    };
    const ctx = { listTypes: new Map([["faq", type]]), includeLists: true };
    const v = { faq: [{ id: E1, node: "qa", values: { title: "Q-17", body: "<p>Yes</p>" } }] };
    expect(translatableStrings([{ name: "faq", kind: "list", listType: "faq" }], v, ctx)).toEqual([
      { path: `faq[${E1}].body`, text: "<p>Yes</p>" },
    ]);
  });

  it("leaves a shared instance's local lists to the address overlay", () => {
    expect(
      translatableStrings(fields, values, { listTypes, includeLists: false }).map((s) => s.path),
    ).toEqual(["tagline"]);
  });

  it("refuses a local list whose type the site does not have", () => {
    expect(() =>
      translatableStrings([{ name: "nav", kind: "list", listType: "gone" }], values, LAYOUT),
    ).toThrow(/list type "gone"/);
  });
});

describe("applyStrings", () => {
  it("writes translations into a copy, keeping hrefs and other values", () => {
    const out = applyStrings(values, {
      tagline: "Mit Sorgfalt",
      [`nav[${E1}].label`]: "Über uns",
      [`tags[${T1}].text`]: "schnell",
    });
    expect(out.tagline).toBe("Mit Sorgfalt");
    expect(out.nav).toEqual([
      { id: E1, node: "link", values: { label: "Über uns", link: { href: "/about" } } },
      {
        id: E2,
        node: "link",
        values: { label: "Pricing", link: { href: "/pricing/?ref=nav#top" } },
      },
    ]);
    expect((out.tags as { values: { text: string } }[]).map((t) => t.values.text)).toEqual([
      "schnell",
      "",
    ]);
    expect(values.tagline).toBe("Made with care");
  });

  it("refuses paths the source does not have", () => {
    expect(() =>
      applyStrings(values, { "nav[00000000-0000-4000-9000-000000000099].label": "x" }),
    ).toThrow(/no list entry text/);
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
    { id: "c1", label: "Menu", strings: [{ path: `nav[${E1}].label`, text: "About" }] },
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
    expect(user).toContain(`nav[${E1}].label:\n\`\`\`\nAbout\n\`\`\``);
  });

  it("accepts exactly the offered targets and paths", () => {
    const ok = {
      targets: [
        { target: "c0", strings: { tagline: "Mit Sorgfalt" } },
        { target: "c1", strings: { [`nav[${E1}].label`]: "Über uns" } },
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
      [`nav[${E1}].label`],
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
        { target: "c1", strings: { [`nav[${E1}].label`]: "Über uns" } },
      ],
    };
    const parsed = chromeTranslationPayload.parse(answer);
    expect(() => validateChromeTranslation(parsed, targets)).not.toThrow();
  });
});

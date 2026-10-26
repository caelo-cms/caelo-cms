// SPDX-License-Identifier: MPL-2.0

/**
 * The per-call translation answer contract. Regression for the live
 * translate_variant failures where OUR request offered a meta description
 * the source page does not have: the model answered one ("refusing to
 * apply invented SEO text") or answered "" for "nothing" (`too_small`).
 * The contract now has no such key when the source has none, and an
 * explicit `null` ("keep the existing one") where an empty string used
 * to be the only way to say nothing.
 */

import { describe, expect, it } from "bun:test";
import {
  alignSlots,
  buildFullTranslationPrompt,
  buildUpdateTranslationPrompt,
  type ContentSlot,
} from "./translation.js";
import {
  toTranslationPayload,
  translationAnswerSchema,
  translationContractOf,
  translationJsonSchema,
} from "./translation-contract.js";

const slot = (
  blockName: string,
  position: number,
  values: Record<string, unknown>,
): ContentSlot => ({ blockName, position, moduleSlug: `m-${blockName}`, values });

const source = [slot("main", 0, { headline: "Welcome", count: 3 }), slot("main", 1, { cta: "Go" })];
const variant = [slot("main", 0, { headline: "Willkommen" })];

const contract = (mode: "full" | "update", sourceMeta: string, variantMeta = "") =>
  translationContractOf({
    mode,
    sourceSlots: source,
    alignment: alignSlots(source, variant),
    sourceMetaDescription: sourceMeta,
    variantMetaDescription: variantMeta,
  });

const answer = {
  title: "Preise",
  shortTitle: "Preise",
  slots: [{ slot: "s0", values: [{ field: "headline", value: "Willkommen" }] }],
};

describe("source page without a meta description", () => {
  const c = contract("full", "");

  it("the structured-output schema has no metaDescription key at all", () => {
    const schema = translationJsonSchema(c) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["title", "shortTitle", "slots"]);
    expect(schema.required).toEqual(["title", "shortTitle", "slots"]);
  });

  it("the prompt never mentions one (full and update mode)", () => {
    const base = {
      sourceLocale: "en",
      targetLocale: "de",
      sourceTitle: "Pricing",
      sourceShortTitle: "Pricing",
      sourceMetaDescription: "",
      sourceSlots: source,
      glossary: [],
      styleGuide: null,
    };
    const full = buildFullTranslationPrompt(base);
    expect(`${full.system}\n${full.user}`).not.toMatch(/meta ?description/i);
    const update = buildUpdateTranslationPrompt({
      ...base,
      variantTitle: "Preise",
      variantShortTitle: "Preise",
      variantMetaDescription: "",
      variantSlots: variant,
      alignment: alignSlots(source, variant),
    });
    expect(`${update.system}\n${update.user}`).not.toMatch(/meta ?description/i);
  });

  it("an answer carrying one — invented or empty — is refused by the contract", () => {
    const schema = translationAnswerSchema(c);
    expect(schema.safeParse(answer).success).toBe(true);
    expect(schema.safeParse({ ...answer, metaDescription: "Erfunden." }).success).toBe(false);
    expect(schema.safeParse({ ...answer, metaDescription: "" }).success).toBe(false);
  });
});

describe("source page with a meta description", () => {
  it("full mode requires a non-empty translated one", () => {
    const c = contract("full", "Fair prices.");
    const schema = translationJsonSchema(c) as { required: string[] };
    expect(schema.required).toContain("metaDescription");
    const zod = translationAnswerSchema(c);
    expect(zod.safeParse(answer).success).toBe(false);
    expect(zod.safeParse({ ...answer, metaDescription: "" }).success).toBe(false);
    expect(zod.safeParse({ ...answer, metaDescription: "x".repeat(321) }).success).toBe(false);
    expect(
      toTranslationPayload(
        zod.parse({ ...answer, metaDescription: "Faire Preise." }) as Parameters<
          typeof toTranslationPayload
        >[0],
      ).metaDescription,
    ).toBe("Faire Preise.");
  });

  it("update mode of a variant that has one: null keeps it, never an empty string", () => {
    const c = contract("update", "Fair prices.", "Faire Preise.");
    const zod = translationAnswerSchema(c);
    expect(zod.safeParse({ ...answer, metaDescription: "" }).success).toBe(false);
    const kept = toTranslationPayload(
      zod.parse({ ...answer, title: null, shortTitle: null, metaDescription: null }) as Parameters<
        typeof toTranslationPayload
      >[0],
    );
    expect(kept).toEqual({ slots: [{ slot: "s0", values: { headline: "Willkommen" } }] });
    expect("metaDescription" in kept).toBe(false);
    expect("title" in kept).toBe(false);
    expect("shortTitle" in kept).toBe(false);
  });

  it("update mode of a variant without one requires it", () => {
    const zod = translationAnswerSchema(contract("update", "Fair prices.", ""));
    expect(zod.safeParse({ ...answer, metaDescription: null }).success).toBe(false);
  });
});

describe("slots", () => {
  it("offers every source slot in full mode, only aligned ones in update mode", () => {
    expect(contract("full", "").slotIds).toEqual(["s0", "s1"]);
    expect(contract("update", "").slotIds).toEqual(["s0"]);
  });

  it("restricts field names to the page's string fields", () => {
    expect(contract("full", "").fieldNames).toEqual(["headline", "cta"]);
    const schema = JSON.stringify(translationJsonSchema(contract("full", "")));
    expect(schema).toContain('"enum":["headline","cta"]');
    expect(schema).toContain('"enum":["s0","s1"]');
  });

  it("every object in the schema is closed (structured-output decoders require it)", () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${path}[${i}]`);
        });
      } else if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o.type === "object" && o.additionalProperties !== false) open.push(path);
        for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      }
    };
    walk(translationJsonSchema(contract("update", "Fair.", "Fair-de.")), "$");
    expect(open).toEqual([]);
  });

  it("pairs become the field record; a field named twice is refused", () => {
    expect(toTranslationPayload(answer).slots).toEqual([
      { slot: "s0", values: { headline: "Willkommen" } },
    ]);
    expect(() =>
      toTranslationPayload({
        title: "T",
        shortTitle: "T",
        slots: [
          {
            slot: "s0",
            values: [
              { field: "headline", value: "a" },
              { field: "headline", value: "b" },
            ],
          },
        ],
      }),
    ).toThrow(/twice/);
  });
});

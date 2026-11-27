// SPDX-License-Identifier: MPL-2.0

/**
 * #1752 — a page's own SEO title, og:title and og:description are
 * translated like its meta description: a key in the answer contract only
 * when the source has the text (required in full mode and while the
 * variant has none, nullable in an update), refused when the source has
 * none, and part of the source fingerprint only when present — so no
 * variant turns stale by the upgrade alone.
 */

import { describe, expect, it } from "bun:test";
import { pageSourceFingerprint } from "./page-translation.js";
import {
  alignSlots,
  buildFullTranslationPrompt,
  buildUpdateTranslationPrompt,
  type ContentSlot,
  validateHeadTexts,
} from "./translation.js";
import {
  type HeadTexts,
  NO_HEAD_TEXTS,
  toTranslationPayload,
  translationAnswerSchema,
  translationContractOf,
  translationJsonSchema,
} from "./translation-contract.js";

const slots: ContentSlot[] = [
  { blockName: "main", position: 0, moduleSlug: "hero", values: { headline: "Welcome" } },
];
const SOURCE: HeadTexts = { seoTitle: "Plans for every team", ogTitle: "", ogDescription: "Share" };

const contract = (mode: "full" | "update", variant: HeadTexts = NO_HEAD_TEXTS) =>
  translationContractOf({
    mode,
    sourceSlots: slots,
    alignment: alignSlots(slots, slots),
    sourceMetaDescription: "",
    variantMetaDescription: "",
    sourceHeadTexts: SOURCE,
    variantHeadTexts: variant,
  });

const answer = { title: "Preise", shortTitle: "Preise", slots: [] };

describe("head texts in the translation contract", () => {
  it("asks only for the texts the source has", () => {
    const c = contract("full");
    expect(c.headTexts).toEqual({
      seoTitle: "required",
      ogTitle: "absent",
      ogDescription: "required",
    });
    const schema = translationJsonSchema(c) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      "title",
      "shortTitle",
      "slots",
      "seoTitle",
      "ogDescription",
    ]);
    expect(schema.required).toContain("seoTitle");
    expect(schema.properties).not.toHaveProperty("ogTitle");
  });

  it("lets an update keep a variant's existing text with null", () => {
    const c = contract("update", { seoTitle: "Preise für Teams", ogTitle: "", ogDescription: "" });
    expect(c.headTexts.seoTitle).toBe("nullable");
    expect(c.headTexts.ogDescription).toBe("required");
    const parsed = translationAnswerSchema(c).parse({
      ...answer,
      seoTitle: null,
      ogDescription: "Teilen",
    });
    expect(toTranslationPayload(parsed)).toEqual({
      title: "Preise",
      shortTitle: "Preise",
      ogDescription: "Teilen",
      slots: [],
    });
  });

  it("refuses an answer missing a required text or carrying one the source lacks", () => {
    expect(() => translationAnswerSchema(contract("full")).parse(answer)).toThrow();
    expect(() =>
      translationAnswerSchema(contract("full")).parse({
        ...answer,
        seoTitle: "Preise",
        ogDescription: "Teilen",
        ogTitle: "invented",
      }),
    ).toThrow();
    expect(() =>
      validateHeadTexts(
        { slots: [], seoTitle: "Preise", ogDescription: "Teilen", ogTitle: "invented" },
        "full",
        SOURCE,
        NO_HEAD_TEXTS,
      ),
    ).toThrow(/source page has none/);
    expect(() => validateHeadTexts({ slots: [] }, "full", SOURCE, NO_HEAD_TEXTS)).toThrow(
      /missing seoTitle/,
    );
  });

  it("shows the texts to the translator, and names a missing one in an update", () => {
    const base = {
      sourceLocale: "en",
      targetLocale: "de",
      sourceTitle: "Pricing",
      sourceShortTitle: "Pricing",
      sourceMetaDescription: "",
      sourceHeadTexts: SOURCE,
      sourceSlots: slots,
      glossary: [],
      styleGuide: null,
    };
    const full = buildFullTranslationPrompt(base);
    expect(full.user).toContain("Plans for every team");
    expect(full.system).toContain('"seoTitle"');
    expect(full.system).not.toContain('"ogTitle"');
    const update = buildUpdateTranslationPrompt({
      ...base,
      variantTitle: "Preise",
      variantShortTitle: "Preise",
      variantMetaDescription: "",
      variantHeadTexts: NO_HEAD_TEXTS,
      variantSlots: slots,
      alignment: alignSlots(slots, slots),
    });
    expect(update.user).toContain("(none yet — translate the source's into seoTitle)");
  });
});

describe("the source fingerprint", () => {
  it("is what it was before head texts existed when the page has none", async () => {
    const page = { title: "Pricing", shortTitle: "Pricing", metaDescription: "D", slots };
    expect(await pageSourceFingerprint({ ...page, headTexts: NO_HEAD_TEXTS })).toBe(
      await pageSourceFingerprint(page),
    );
    expect(await pageSourceFingerprint({ ...page, headTexts: SOURCE })).not.toBe(
      await pageSourceFingerprint(page),
    );
  });
});

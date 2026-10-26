// SPDX-License-Identifier: MPL-2.0

/**
 * The answer contract of one page translation, derived per call from what
 * the page actually has — ONE source for the JSON Schema the install's
 * model is constrained to (`ctx.ai.generateObject`, CLAUDE.md §12), the
 * Zod schema every answer is validated with (install-side and Power-MCP
 * work items alike), and the prose the prompt describes it in.
 *
 * Why per call: a fixed contract that always listed `metaDescription`
 * invited the model to answer one for a page that has none — refused as
 * invented SEO text — or to answer `""` for "nothing", refused by the
 * `min(1)`. Both were OUR request offering a field the page has no value
 * for and no way to say "keep it". Now:
 *
 *   - the source has no meta description → the key does not exist in the
 *     contract at all;
 *   - the variant needs one (full mode, or an update of a variant without
 *     one) → it is required and non-empty;
 *   - an update of a variant that has one → it is required and nullable:
 *     `null` says "the existing one still fits", never an empty string.
 *
 * The title and the short title (#1142, the breadcrumb label) follow the
 * same rule (required in full mode, nullable in update mode). Slot values are `[{field, value}]` pairs, not a free-form
 * record: structured-output decoders (Anthropic's) force
 * `additionalProperties: false` on every object, which would turn a
 * record into an object that can hold nothing.
 */

import { z } from "@caelo-cms/plugin-sdk";
import type { ContentSlot, SlotAlignment, TranslationResultPayload } from "./translation.js";

/**
 * The identifier the translator echoes back, and the ONLY one it sees.
 *
 * A slot is really (blockName, position), but asking the model to
 * reproduce two fields alongside a third it must not use (moduleSlug)
 * invites exactly one mistake: a live run returned the module slug as
 * the block name, the structural lock refused the whole translation,
 * and the AI fell back to translating by hand. An opaque positional id
 * removes the choice — there is one token, it is meaningless on its
 * own, and copying it is the only thing that can be done with it.
 *
 * Derived from the SOURCE order, so ids are stable within one call.
 */
export function slotIdOf(index: number): string {
  return `s${index}`;
}

/** `pages_seo.meta_description` hard cap (shared/seo.ts). */
const SEO_DESCRIPTION_HARD_MAX = 320;

/** What one translation answer may and must carry. */
export interface TranslationContract {
  readonly mode: "full" | "update";
  /** Slot ids the answer may use: every source slot in full mode, only
   *  the aligned ones in update mode (the structural lock). */
  readonly slotIds: readonly string[];
  /** Every translatable (string) field name on the source page. */
  readonly fieldNames: readonly string[];
  /** `absent`: the source has none — the key does not exist.
   *  `required`: a translated description must be returned.
   *  `nullable`: return one only when the existing no longer fits, else null. */
  readonly metaDescription: "absent" | "required" | "nullable";
}

/** Derive the contract from what the source and the variant have. */
export function translationContractOf(input: {
  mode: "full" | "update";
  sourceSlots: readonly ContentSlot[];
  alignment: readonly SlotAlignment[];
  sourceMetaDescription: string;
  variantMetaDescription: string;
}): TranslationContract {
  const alignedKeys = new Set(
    input.alignment.filter((a) => a.kind === "aligned").map((a) => `${a.blockName}|${a.position}`),
  );
  const slotIds = input.sourceSlots.flatMap((s, i) =>
    input.mode === "full" || alignedKeys.has(`${s.blockName}|${s.position}`) ? [slotIdOf(i)] : [],
  );
  const fieldNames = [
    ...new Set(
      input.sourceSlots.flatMap((s) =>
        Object.entries(s.values)
          .filter(([, v]) => typeof v === "string")
          .map(([k]) => k),
      ),
    ),
  ];
  let metaDescription: TranslationContract["metaDescription"];
  if (input.sourceMetaDescription.length === 0) metaDescription = "absent";
  else if (input.mode === "full" || input.variantMetaDescription.length === 0) {
    metaDescription = "required";
  } else metaDescription = "nullable";
  return { mode: input.mode, slotIds, fieldNames, metaDescription };
}

/** A string schema restricted to `values` (unrestricted when there are none). */
function stringEnum(values: readonly string[]): Record<string, unknown> {
  return values.length > 0 ? { type: "string", enum: [...values] } : { type: "string" };
}

/** The JSON Schema `ctx.ai.generateObject` constrains the answer to. */
export function translationJsonSchema(c: TranslationContract): Record<string, unknown> {
  const titleText = { type: "string", minLength: 1, description: "The translated page title." };
  const shortTitleText = {
    type: "string",
    minLength: 1,
    maxLength: 256,
    description: "The translated short title: the page's label in breadcrumbs and menus.",
  };
  const meta = {
    type: "string",
    minLength: 1,
    maxLength: SEO_DESCRIPTION_HARD_MAX,
    description:
      "The translated meta description, written as a search-result snippet in the target language (aim for 160 characters).",
  };
  const properties: Record<string, unknown> = {
    title:
      c.mode === "full"
        ? titleText
        : {
            anyOf: [titleText, { type: "null" }],
            description: "The re-translated title, or null when the existing one still fits.",
          },
    shortTitle:
      c.mode === "full"
        ? shortTitleText
        : {
            anyOf: [shortTitleText, { type: "null" }],
            description: "The re-translated short title, or null when the existing one still fits.",
          },
    slots: {
      type: "array",
      ...(c.slotIds.length === 0 ? { maxItems: 0 } : {}),
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "values"],
        properties: {
          slot: {
            ...stringEnum(c.slotIds),
            description: 'The slot id from the "### Slot <id>" heading, copied exactly.',
          },
          values: {
            type: "array",
            ...(c.fieldNames.length === 0 ? { maxItems: 0 } : {}),
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "value"],
              properties: {
                field: stringEnum(c.fieldNames),
                value: { type: "string", description: "The translated string." },
              },
            },
          },
        },
      },
    },
  };
  const required = ["title", "shortTitle", "slots"];
  if (c.metaDescription === "required") {
    properties.metaDescription = meta;
    required.push("metaDescription");
  } else if (c.metaDescription === "nullable") {
    properties.metaDescription = {
      anyOf: [meta, { type: "null" }],
      description: "The re-translated meta description, or null when the existing one still fits.",
    };
    required.push("metaDescription");
  }
  return { type: "object", additionalProperties: false, required, properties };
}

/** The Zod mirror of {@link translationJsonSchema} — every answer passes it. */
export function translationAnswerSchema(c: TranslationContract) {
  const title = z.string().min(1);
  const shortTitle = z.string().trim().min(1).max(256);
  const meta = z.string().min(1).max(SEO_DESCRIPTION_HARD_MAX);
  const base = {
    title: c.mode === "full" ? title : title.nullable(),
    shortTitle: c.mode === "full" ? shortTitle : shortTitle.nullable(),
    slots: z.array(
      z
        .object({
          slot: z.string().min(1),
          values: z.array(z.object({ field: z.string().min(1), value: z.string() }).strict()),
        })
        .strict(),
    ),
  };
  if (c.metaDescription === "absent") return z.object(base).strict();
  return z
    .object({
      ...base,
      metaDescription: c.metaDescription === "required" ? meta : meta.nullable(),
    })
    .strict();
}

/** A validated answer in the contract's wire shape. */
export type TranslationAnswer = z.infer<ReturnType<typeof translationAnswerSchema>>;

/**
 * Wire shape → the payload the write path applies: pairs become a field
 * record, `null` ("keep the existing one") becomes an absent key.
 *
 * @throws on a field named twice in one slot — which value is meant is
 *   unknowable, so it is refused rather than last-one-wins.
 */
export function toTranslationPayload(answer: TranslationAnswer): TranslationResultPayload {
  const slots = answer.slots.map((s) => {
    const values: Record<string, string> = {};
    for (const { field, value } of s.values) {
      if (Object.hasOwn(values, field)) {
        throw new Error(`slot ${s.slot} names field "${field}" twice — refusing to guess`);
      }
      values[field] = value;
    }
    return { slot: s.slot, values };
  });
  const metaDescription: string | null =
    "metaDescription" in answer && typeof answer.metaDescription === "string"
      ? answer.metaDescription
      : null;
  return {
    ...(answer.title !== null ? { title: answer.title } : {}),
    ...(answer.shortTitle !== null ? { shortTitle: answer.shortTitle } : {}),
    ...(metaDescription !== null ? { metaDescription } : {}),
    slots,
  };
}

/** The prose half of the contract, for the system prompt. */
export function translationContractText(c: TranslationContract): string {
  const title =
    c.mode === "full"
      ? '"title": "<translated page title>", "shortTitle": "<translated short title — the page\'s label in breadcrumbs and menus, as short as the source\'s>"'
      : '"title": "<re-translated page title>" or null when the existing title still fits, "shortTitle": "<re-translated short title>" or null when the existing one still fits';
  const meta =
    c.metaDescription === "required"
      ? ', "metaDescription": "<translated meta description — a search-result snippet in the target language, at most 320 characters, aim for 160>"'
      : c.metaDescription === "nullable"
        ? ', "metaDescription": "<re-translated meta description, at most 320 characters>" or null when the existing one still fits'
        : "";
  return (
    `Respond with ONE JSON object: {${title}${meta}, "slots": [{"slot": "<the slot id from the heading, copied EXACTLY — e.g. s0>", "values": [{"field": "<field name from the slot>", "value": "<translated string>"}, ...]}, ...]}. ` +
    'Never invent a slot id and never substitute the module slug or block name for it — copy the "### Slot <id>" token verbatim. ' +
    "Include ONLY string fields you translated, each once; preserve every HTML tag, attribute, class, id, href, and inline style inside field values verbatim — only human-readable text is translated. Numbers, code samples, and untranslatable proper nouns stay as-is."
  );
}

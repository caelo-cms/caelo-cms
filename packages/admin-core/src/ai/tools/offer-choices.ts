// SPDX-License-Identifier: MPL-2.0

/**
 * offer_choices — render an operator question as CLICKABLE buttons in
 * the chat instead of "answer with A or B" prose (operator feedback,
 * 2026-07-12: "i need to answer with a or b insted i can click").
 *
 * Pure UI affordance: no DB write, no side effects. The chat's
 * ChoiceCard parses the canonical content shape below and posts the
 * clicked option back as the operator's message.
 *
 * Canonical content shape (ChoiceCard contract):
 *   "Choices offered: <question>\n<KEY>) <label> — <description>\n…"
 */

import { z } from "zod";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const offerChoicesInput = z
  .object({
    // ChoiceCard parses the content line-based (`<KEY>) <label> — <desc>`)
    // — newlines inside any field would break the contract, and keys
    // must stay short + delimiter-free.
    question: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[^\n]+$/, "no newlines"),
    options: z
      .array(
        z
          .object({
            key: z.string().regex(/^[A-Za-z0-9]{1,3}$/, "1-3 alphanumeric characters"),
            label: z
              .string()
              .min(1)
              .max(120)
              .regex(/^[^\n]+$/, "no newlines"),
            description: z
              .string()
              .min(1)
              .max(300)
              .regex(/^[^\n]+$/, "no newlines")
              .optional(),
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();
type OfferChoicesInput = z.infer<typeof offerChoicesInput>;

export const offerChoicesTool: ToolDefinitionWithHandler<OfferChoicesInput> = {
  name: "offer_choices",
  description:
    "Present the operator a small multiple-choice question as CLICKABLE BUTTONS in the chat. " +
    "Use this whenever you would otherwise write 'answer with A or B' — design fork, crawl scope, " +
    "cluster confirmation, any pick-one moment with 2-4 options. " +
    "END YOUR TURN right after calling it and WAIT for the click (it arrives as the operator's " +
    "next message, containing the option's key and label). " +
    "Do NOT use it for open questions (names, URLs, free text) or when an option list would " +
    "hide better answers the operator might type.",
  schema: offerChoicesInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["question", "options"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: 500, pattern: "^[^\\n]+$" },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "label"],
          properties: {
            key: { type: "string", pattern: "^[A-Za-z0-9]{1,3}$" },
            label: { type: "string", minLength: 1, maxLength: 120, pattern: "^[^\\n]+$" },
            description: { type: "string", minLength: 1, maxLength: 300, pattern: "^[^\\n]+$" },
          },
        },
      },
    },
  },
  handler: (_ctx, input) => {
    const lines = input.options.map(
      (o) => `${o.key}) ${o.label}${o.description ? ` — ${o.description}` : ""}`,
    );
    return Promise.resolve({
      ok: true,
      content: `Choices offered: ${input.question}\n${lines.join("\n")}`,
    });
  },
};

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
    question: z.string().min(1).max(500),
    options: z
      .array(
        z
          .object({
            key: z.string().min(1).max(3),
            label: z.string().min(1).max(120),
            description: z.string().min(1).max(300).optional(),
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
      question: { type: "string", minLength: 1, maxLength: 500 },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "label"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 3 },
            label: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: "string", minLength: 1, maxLength: 300 },
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

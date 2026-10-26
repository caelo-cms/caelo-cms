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
    "Ask the operator a small multiple-choice question as CLICKABLE BUTTONS in chat.\n" +
    "USE FOR: a genuine trade-off only the operator can decide (design fork, crawl scope, destructive disposition).\n" +
    "DO NOT USE FOR: steps you can safely do yourself and mention after (e.g. footer links to missing pages -> CREATE those pages and say so; implementation questions are yours) | open questions (names, URLs, free text) | when a fixed list would hide better typed answers.\n" +
    "CORE RULES: END YOUR TURN right after calling and WAIT; the click arrives as the operator's next message with the option's key + label.",
  schema: offerChoicesInput,
  // issue #251 (WS5) — inputSchema derived from `schema` at registration.
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

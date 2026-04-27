// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: site_memory_propose. Queues a proposal in
 * `site_memory_proposals`; never writes to `site_ai_memory` directly.
 * Owners review the queue at /security/ai/memory-proposals.
 */

import { execute } from "@caelo/query-api";
import { siteMemoryProposeToolInput } from "@caelo/shared";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const siteMemoryProposeTool: ToolDefinitionWithHandler<
  import("@caelo/shared").SiteMemoryProposeToolInput
> = {
  // P6.7.2 — Anthropic's tool-name validator rejects dots
  // (`^[a-zA-Z0-9_-]{1,128}$`). Keep this as snake_case so the live
  // provider call works; tests using the fixture provider don't
  // enforce this regex but the live API does.
  name: "site_memory_propose",
  description:
    "Propose an addition to the site's AI memory (brand voice, tone, banned " +
    "phrases, instructions, glossary). The proposal queues for Owner review " +
    "and only takes effect if accepted.",
  schema: siteMemoryProposeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slot", "body", "rationale"],
    properties: {
      slot: {
        type: "string",
        enum: ["brand-voice", "tone", "banned-phrases", "instructions", "glossary"],
      },
      body: { type: "string", minLength: 1, maxLength: 4000 },
      rationale: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_memory.propose", {
      slot: input.slot,
      body: input.body,
      rationale: input.rationale,
      chatSessionId: toolCtx.chatSessionId ?? null,
    });
    if (result.ok) {
      return {
        ok: true,
        content: `proposal queued for Owner review (slot=${input.slot})`,
      };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};

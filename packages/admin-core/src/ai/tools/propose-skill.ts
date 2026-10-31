// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — `propose_skill`. AI drafts a new skill (or skill revision)
 * and queues it for Owner review. CLAUDE.md §2 requires human Owner
 * activation for any new skill — this tool only QUEUES; it does not
 * activate.
 */

import { execute } from "@caelo-cms/query-api";
import { type ProposeSkillToolInput, proposeSkillToolInput } from "@caelo-cms/shared";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const proposeSkillTool: ToolDefinitionWithHandler<ProposeSkillToolInput> = {
  name: "propose_skill",
  description:
    "Draft a new AI skill (instructions augmenting your future system prompt) and QUEUE it for Owner review.\n" +
    "USE FOR: the user explicitly asks you to learn a behaviour, codify a workflow, or persist a habit.\n" +
    "CORE RULES: TWO-STEP, not in chat: an Owner accepts/rejects at /settings/skills/proposals (accept -> `awaiting_activation`), then separately activates it site-wide. Never claim the skill is active.",
  schema: proposeSkillToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "body", "rationale"],
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
      body: {
        type: "string",
        minLength: 1,
        maxLength: 20000,
        description: "The skill instructions.",
      },
      rationale: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description: "Why this skill helps.",
      },
      allowlistedTools: {
        type: "array",
        items: { type: "string", maxLength: 120 },
        description:
          "AI tool names (e.g. `update_modules_many`, `list_pages`) the workflow calls -> list every one. load_skill names them for loading; NOT a restriction. Query-API op names (`pages.list`) are rejected.",
      },
      hints: {
        type: "object",
        additionalProperties: false,
        properties: {
          keywords: {
            type: "array",
            items: { type: "string", maxLength: 80 },
          },
          chipTrigger: { type: "boolean" },
          alwaysOn: { type: "boolean" },
        },
        description: "Auto-engagement matcher hints.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.propose", input);
    if (!r.ok) {
      return toolError(r.error, `propose_skill failed: ${describeError(r.error)}`);
    }
    const { proposalId } = r.value as { proposalId: string };
    return {
      ok: true,
      content:
        `Queued skill proposal ${proposalId} (slug=${input.slug}). ` +
        `An Owner must accept it at /settings/skills/proposals; after acceptance, the Owner activates the skill separately. The skill is NOT active yet.`,
      queuedProposalId: proposalId,
    };
  },
};

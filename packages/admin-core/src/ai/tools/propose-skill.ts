// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — `propose_skill`. AI drafts a new skill (or skill revision)
 * and queues it for Owner review. CLAUDE.md §2 requires human Owner
 * activation for any new skill — this tool only QUEUES; it does not
 * activate.
 */

import { execute } from "@caelo-cms/query-api";
import { type ProposeSkillToolInput, proposeSkillToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const proposeSkillTool: ToolDefinitionWithHandler<ProposeSkillToolInput> = {
  name: "propose_skill",
  description:
    "Draft a new AI skill (instructional body that augments your future system prompt) and queue it for Owner review. " +
    "TWO-STEP: this only QUEUES the proposal — an Owner reviews it at /security/skills/proposals and either accepts (creating a 'awaiting_activation' skill) or rejects. After acceptance the Owner separately activates the skill site-wide. " +
    "Do NOT claim the skill is active. Use this when the user explicitly asks you to learn a new behaviour, codify a workflow, or persist a habit. " +
    "Inputs: slug (lowercase-with-hyphens), displayName, description, body (the skill instructions), rationale (why this skill helps), allowlistedTools (optional list of AI TOOL names — e.g. edit_module, list_pages — that this skill narrows the catalogue's WRITE tools to; Query-API op names like pages.list are rejected), hints (optional auto-engagement matcher hints).",
  schema: proposeSkillToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "body", "rationale"],
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
      body: { type: "string", minLength: 1, maxLength: 20000 },
      rationale: { type: "string", minLength: 1, maxLength: 1000 },
      allowlistedTools: {
        type: "array",
        items: { type: "string", maxLength: 120 },
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
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.propose", input);
    if (!r.ok) {
      return { ok: false, content: `propose_skill failed: ${describeError(r.error)}` };
    }
    const { proposalId } = r.value as { proposalId: string };
    return {
      ok: true,
      content:
        `Queued skill proposal ${proposalId} (slug=${input.slug}). ` +
        `An Owner must accept it at /security/skills/proposals; after acceptance, the Owner activates the skill separately. The skill is NOT active yet.`,
    };
  },
};

// SPDX-License-Identifier: MPL-2.0

/**
 * `activate_plugin` — the AI's route from "this site has a plugin for
 * that, switched off" to actually using it, without sending the
 * operator out of the conversation.
 *
 * Pairs with `list_plugins` and the installed-but-inactive line in the
 * system prompt: those let the AI NOTICE a dormant capability, this
 * lets it ACT on the noticing. The §11.A gate is unchanged — the SDK
 * pauses on the approval card, the operator clicks, and only then does
 * anything load.
 */

import { z } from "zod";
import { makeProposeTool } from "./_make-propose-tool.js";

const activatePluginInput = z
  .object({
    slug: z.string().min(1).max(120),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type ActivatePluginInput = z.infer<typeof activatePluginInput>;

export const activatePluginTool = makeProposeTool<ActivatePluginInput>({
  toolName: "activate_plugin",
  opName: "plugins.propose_activation",
  executeOpOverride: "plugins.execute_activation",
  afterApply: "load-activated-plugin",
  pendingQueuePath: "/settings/plugins/pending",
  when:
    "Activate an installed-but-inactive plugin so its tools + skills become usable.\n" +
    "USE FOR: a request no current tool covers while `list_plugins` (or the installed-plugins note) shows a plugin providing it -> say what it enables + propose in the same turn; never send the operator to a settings screen.\n" +
    "DO NOT USE speculatively: activating runs code, claims URL slots, starts workers; propose only what the request needs.\n" +
    "After approval it loads at once, but its tools reach you NEXT turn -> end this turn saying what you will do next; don't call them yet.",
  schema: activatePluginInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: { type: "string", maxLength: 120, description: "From `list_plugins`." },
      reason: {
        type: "string",
        maxLength: 500,
        description: "One line why; shown on the approval card.",
      },
    },
  },
  summarize: (input, preview) => {
    const tools = (preview.toolsAdded as string[] | undefined) ?? [];
    const skills = (preview.skillsActivated as string[] | undefined) ?? [];
    const parts = [`activate ${input.slug}`];
    if (tools.length > 0) parts.push(`${tools.length} tool(s)`);
    if (skills.length > 0) parts.push(`${skills.length} skill(s)`);
    return parts.join(" — ");
  },
});

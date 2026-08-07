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
  pendingQueuePath: "/security/plugins",
  when:
    "Activate an installed-but-inactive plugin so its tools and skills become usable. " +
    "Use when the operator asks for something you have no tool for AND list_plugins (or the installed-plugins note) shows a plugin that provides it — say what it will enable and propose the activation in the same turn, rather than telling the operator to go find a settings screen. " +
    "Do NOT use it speculatively: activating runs code, claims URL slots, and starts background workers. Propose only what the operator's request actually needs. " +
    "After approval the plugin loads immediately, but its tools reach you on your NEXT turn — this turn's tool list was fixed before the approval, so finish this turn by telling the operator what you will do next rather than calling the new tools. " +
    "Inputs: slug (from list_plugins), and reason — one line on why, shown to the operator on the approval card.",
  schema: activatePluginInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: { type: "string", maxLength: 120 },
      reason: { type: "string", maxLength: 500 },
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

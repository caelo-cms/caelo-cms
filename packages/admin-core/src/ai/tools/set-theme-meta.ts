// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.4 (issue #76 follow-up) — AI tool: set_theme_meta.
 *
 * The AI's surface for recording WHY a theme looks the way it does.
 * Pair with `set_theme_tokens` when evolving a seed palette: write the
 * tokens, then write a one-paragraph design intent the next turn can
 * read in the `## Theme` system-prompt block.
 *
 * Per CLAUDE.md §1A: the description is decision-support context for
 * the next AI turn. Without it, a future "tweak the secondary colour"
 * request lands without knowing the brand direction.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const setThemeMetaToolInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    /**
     * Short paragraph describing the design intent — palette
     * inspiration, typography pairing, brand context. Carried into
     * the `## Theme` system-prompt block so future turns stay
     * consistent. Pass `null` to clear.
     */
    description: z.string().max(1000).nullable().optional(),
    /** Human-readable name shown in the admin UI + system prompt. */
    displayName: z.string().min(1).max(200).optional(),
  })
  .strict();
type SetThemeMetaToolInput = z.infer<typeof setThemeMetaToolInput>;

export const setThemeMetaTool: ToolDefinitionWithHandler<SetThemeMetaToolInput> = {
  name: "set_theme_meta",
  description:
    "Record the design intent (description) and / or display name of a theme. Use AFTER " +
    "you change tokens on a `seed`-origin theme so the next turn knows WHY the palette " +
    "is what it is — without this, future tweaks lose the brand context. Example: " +
    "`set_theme_meta({description: 'Indigo primary (#4f46e5) chosen for a SaaS B2B " +
    "feel. System fonts. 0.5rem radius for a softer-than-default Tailwind look.'})`. " +
    "Defaults to the active theme; pass `themeSlug` to target a specific one. " +
    "Pass `description: null` to clear.",
  schema: setThemeMetaToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      themeSlug: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: ["string", "null"], maxLength: 1000 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.update_meta", input);
    if (!r.ok) {
      return { ok: false, content: `themes.update_meta failed: ${describeError(r.error)}` };
    }
    const parts: string[] = [];
    if (input.description !== undefined) {
      parts.push(input.description === null ? "cleared description" : "set description");
    }
    if (input.displayName !== undefined) parts.push(`renamed to "${input.displayName}"`);
    return { ok: true, content: parts.length > 0 ? parts.join(", ") : "no-op" };
  },
};

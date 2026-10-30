// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: duplicate_theme. Clones an existing theme's
 * tokens + asset FKs under a fresh slug (inactive). Operators reach
 * for this when they want to spin a brand variant from the current
 * active theme without going through propose_create (no token
 * document to compose; the duplicate IS the starting point).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const duplicateThemeToolInput = z
  .object({
    sourceSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    newSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    newDisplayName: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
  })
  .strict();
type DuplicateThemeToolInput = z.infer<typeof duplicateThemeToolInput>;

export const duplicateThemeTool: ToolDefinitionWithHandler<DuplicateThemeToolInput> = {
  name: "duplicate_theme",
  description:
    "Clone a theme into a new inactive variant (tokens + asset bindings copied verbatim; activate via `propose_activate_theme`) — a brand variant without enumerating tokens. No source to clone -> `propose_create_theme` with a token document you compose.",
  schema: duplicateThemeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceSlug", "newSlug", "newDisplayName"],
    properties: {
      sourceSlug: { type: "string", minLength: 1, maxLength: 120 },
      newSlug: { type: "string", minLength: 1, maxLength: 120 },
      newDisplayName: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.duplicate", input);
    if (!r.ok) return toolError(r.error, `themes.duplicate failed: ${describeError(r.error)}`);
    const v = r.value as { themeId: string; slug: string };
    return {
      ok: true,
      content: `cloned '${input.sourceSlug}' → '${v.slug}' (themeId ${v.themeId}). Use propose_activate_theme to switch the live site to it.`,
    };
  },
};

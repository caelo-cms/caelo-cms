// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: duplicate_theme. Clones an existing theme's
 * tokens + asset FKs under a fresh slug (inactive). Operators reach
 * for this when they want to spin a brand variant from the current
 * active theme without going through propose_create (no preset
 * resolution needed; the duplicate IS the preset).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
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
    "Clone an existing theme into a new (inactive) variant. Copies tokens + asset FKs " +
    "verbatim; the new theme has `is_active=false` so activation goes through " +
    "`propose_activate_theme`. Use when the operator wants a brand variant of the current " +
    "theme without enumerating tokens. For brand variants WITHOUT a source theme to clone, " +
    "use `propose_create_theme({preset, overrides})` instead.",
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
    if (!r.ok) return { ok: false, content: `themes.duplicate failed: ${describeError(r.error)}` };
    const v = r.value as { themeId: string; slug: string };
    return {
      ok: true,
      content: `cloned '${input.sourceSlug}' → '${v.slug}' (themeId ${v.themeId}). Use propose_activate_theme to switch the live site to it.`,
    };
  },
};

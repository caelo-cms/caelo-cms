// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: get_theme. Fetches the full DTCG document for one
 * theme. The `as` parameter that emits Tailwind / CSS-var / summary
 * formats lands in v0.11.1 — for this slice the AI gets DTCG only.
 */

import { execute } from "@caelo-cms/query-api";
import type { Theme } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const getThemeToolInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .strict();
type GetThemeToolInput = z.infer<typeof getThemeToolInput>;

export const getThemeTool: ToolDefinitionWithHandler<GetThemeToolInput> = {
  name: "get_theme",
  description:
    "Fetch one theme's full DTCG tokens jsonb + asset URL refs. Use when you need to " +
    "see the current token values before partial-updating, OR before duplicating into a " +
    "brand variant. The system-prompt `## Theme` block summarises the active theme by " +
    "category count; this tool returns the raw document for inspection. " +
    "v0.11.1 will add an `as` parameter for CSS-var / Tailwind / summary output formats — " +
    "for now this returns DTCG JSON only.",
  schema: getThemeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: { slug: { type: "string", minLength: 1, maxLength: 120 } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get", input);
    if (!r.ok) return { ok: false, content: `themes.get failed: ${describeError(r.error)}` };
    const theme = (r.value as { theme: Theme | null }).theme;
    if (!theme) {
      return {
        ok: false,
        content: `theme '${input.slug}' not found — call list_themes to see what's available.`,
      };
    }
    return { ok: true, content: JSON.stringify(theme, null, 2) };
  },
};

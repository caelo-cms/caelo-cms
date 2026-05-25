// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — AI tool: get_theme.
 *
 * Returns the theme in one of four shapes via the `as` parameter:
 *   - `dtcg` (default) — full DTCG document, what design tooling expects
 *   - `css-vars` — rendered `:root { … }` block, byte-identical to the public site
 *   - `tailwind` — `@theme inline { … }` block mapping DTCG paths to Tailwind 4 var names
 *   - `summary` — terse one-line shorthand (palette feel, body font, default radius)
 *
 * `summary` is what the system-prompt `## Theme` block emits at session
 * start; the AI calls `get_theme(as: "css-vars")` when writing module
 * HTML that references `var(--color-…)` so it doesn't have to mentally
 * translate DTCG paths.
 */

import { execute } from "@caelo-cms/query-api";
import {
  formatThemeAsCssVars,
  formatThemeAsTailwind,
  formatThemeSummary,
  type Theme,
} from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const AS_VALUES = ["dtcg", "css-vars", "tailwind", "summary"] as const;
type AsFormat = (typeof AS_VALUES)[number];

const getThemeToolInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    as: z.enum(AS_VALUES).default("dtcg"),
  })
  .strict();
type GetThemeToolInput = z.infer<typeof getThemeToolInput>;

export const getThemeTool: ToolDefinitionWithHandler<GetThemeToolInput> = {
  name: "get_theme",
  description:
    "Read a theme in one of four shapes. Default `dtcg` returns the full DTCG document. " +
    "`css-vars` returns the rendered `:root { … }` block — what the public site ships. " +
    "`tailwind` returns a `@theme inline { … }` block mapping the tokens to Tailwind 4 " +
    "variable names. `summary` returns a tiny `'primary=…, body=…, radius=…, N color/M typography…'` " +
    "+ active flag — what the system-prompt `## Theme` block emits at session start. " +
    "Use `css-vars` when writing module HTML that references `var(--color-…)` so you don't " +
    "have to mentally translate DTCG paths.",
  schema: getThemeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      as: {
        type: "string",
        enum: [...AS_VALUES],
        default: "dtcg",
        description: "Output format: dtcg (default) | css-vars | tailwind | summary.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get", {
      slug: input.slug,
    });
    if (!r.ok) return { ok: false, content: `themes.get failed: ${describeError(r.error)}` };
    const theme = (r.value as { theme: Theme | null }).theme;
    if (!theme) {
      return {
        ok: false,
        content: `theme '${input.slug}' not found — call list_themes to see what's available.`,
      };
    }
    const as: AsFormat = input.as;
    switch (as) {
      case "dtcg":
        return { ok: true, content: JSON.stringify(theme, null, 2) };
      case "css-vars":
        return { ok: true, content: formatThemeAsCssVars(theme.tokens) };
      case "tailwind":
        return { ok: true, content: formatThemeAsTailwind(theme.tokens) };
      case "summary":
        return {
          ok: true,
          content: `${theme.displayName} (${theme.slug}, ${theme.isActive ? "active" : "inactive"}): ${formatThemeSummary(theme.tokens)}`,
        };
    }
  },
};

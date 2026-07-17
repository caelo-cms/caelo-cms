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
    /**
     * Omit for the ACTIVE theme (the 95% case — live-edit run B showed
     * the model guessing 'default'/'active' when it had to name one).
     */
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    as: z.enum(AS_VALUES).default("dtcg"),
  })
  .strict();
type GetThemeToolInput = z.infer<typeof getThemeToolInput>;

/**
 * One-line inventory of every theme — appended on fallback/miss so the
 * AI never needs a list_themes round-trip. `always` controls the
 * single-theme case: a MISS always shows the inventory (the correction
 * needs it); the active-theme fallback only mentions variants when
 * variants actually exist.
 */
async function themeInventoryLine(
  ctx: Parameters<ToolDefinitionWithHandler<GetThemeToolInput>["handler"]>[0],
  toolCtx: Parameters<ToolDefinitionWithHandler<GetThemeToolInput>["handler"]>[2],
  always: boolean,
): Promise<string> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.list", {});
  if (!r.ok) return "";
  const themes = (r.value as { themes: { slug: string; isActive: boolean }[] }).themes;
  if (themes.length === 0 || (!always && themes.length <= 1)) return "";
  return `\nAll themes: ${themes.map((t) => `${t.slug}${t.isActive ? " (active)" : ""}`).join(", ")}.`;
}

export const getThemeTool: ToolDefinitionWithHandler<GetThemeToolInput> = {
  name: "get_theme",
  description:
    "Read a theme in one of four shapes. OMIT `slug` for the ACTIVE theme (the routine case). " +
    "Default `as: dtcg` returns the full DTCG document. " +
    "`css-vars` returns the rendered `:root { … }` block — what the public site ships. " +
    "`tailwind` returns a `@theme inline { … }` block mapping the tokens to Tailwind 4 " +
    "variable names. `summary` returns a tiny `'primary=…, body=…, radius=…'` + active flag. " +
    "Use `css-vars` when writing module HTML that references `var(--color-…)` so you don't " +
    "have to mentally translate DTCG paths.",
  schema: getThemeToolInput,
  inputSchema: z.toJSONSchema(getThemeToolInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    let theme: Theme | null;
    let fallbackNote = "";
    if (input.slug === undefined) {
      // No slug → the active theme, plus a one-liner naming the others
      // so the model knows variants exist without a list round-trip.
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
      if (!r.ok)
        return { ok: false, content: `themes.get_active failed: ${describeError(r.error)}` };
      theme = (r.value as { theme: Theme | null }).theme;
      if (!theme) {
        return { ok: false, content: "no active theme on this site — call list_themes." };
      }
      fallbackNote = await themeInventoryLine(ctx, toolCtx, false);
    } else {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get", {
        slug: input.slug,
      });
      if (!r.ok) return { ok: false, content: `themes.get failed: ${describeError(r.error)}` };
      theme = (r.value as { theme: Theme | null }).theme;
      if (!theme) {
        // Miss → answer with the inventory INLINE so the model corrects
        // in ONE step instead of the not-found → list_themes → retry
        // detour (live-edit run B burned two calls guessing slugs).
        const inventory = await themeInventoryLine(ctx, toolCtx, true);
        return {
          ok: false,
          content: `theme '${input.slug}' does not exist.${inventory || "\nNo other themes exist either."} Retry with one of these slugs (or omit slug for the active theme).`,
        };
      }
    }
    const as: AsFormat = input.as;
    switch (as) {
      case "dtcg":
        return { ok: true, content: JSON.stringify(theme, null, 2) + fallbackNote };
      case "css-vars":
        return { ok: true, content: formatThemeAsCssVars(theme.tokens) + fallbackNote };
      case "tailwind":
        return { ok: true, content: formatThemeAsTailwind(theme.tokens) + fallbackNote };
      case "summary":
        return {
          ok: true,
          content: `${theme.displayName} (${theme.slug}, ${theme.isActive ? "active" : "inactive"}): ${formatThemeSummary(theme.tokens)}${fallbackNote}`,
        };
    }
  },
};

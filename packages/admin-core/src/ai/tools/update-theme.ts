// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: update_theme. Convenience alias over `set_structured_set`
 * for the `theme/site` set. Takes a flat map of token → value and
 * merges into whatever's already there. Tokens are CSS variable names
 * (lowercase kebab-case) like `color-primary`, `font-heading`.
 *
 * Why a separate tool: `set_structured_set` requires the AI to know
 * the kind name, slug, and discriminated item shape; `update_theme`
 * lets the AI just pass `{tokens: {colorPrimary: '#0066ff'}}` and
 * have the tool do the rest. Reduces tool-call confusion in practice.
 */

import { execute } from "@caelo/query-api";
import { updateThemeToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface ThemeTokenItem {
  token: string;
  value: string;
  scope?: "color" | "font" | "space" | "radius" | "shadow";
}

function inferScope(token: string): ThemeTokenItem["scope"] {
  const t = token.toLowerCase();
  if (t.startsWith("color")) return "color";
  if (t.startsWith("font")) return "font";
  if (t.startsWith("space")) return "space";
  if (t.startsWith("radius")) return "radius";
  if (t.startsWith("shadow")) return "shadow";
  return undefined;
}

function camelToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export const updateThemeTool: ToolDefinitionWithHandler<
  import("@caelo/shared").UpdateThemeToolInput
> = {
  name: "update_theme",
  description:
    "Update one or more site theme tokens (CSS variables). Pass `{tokens: {colorPrimary: '#0066ff', fontHeading: 'Inter'}}`. " +
    "Tokens are merged with existing values — only what you pass changes. After this runs, any module HTML can use " +
    "`var(--color-primary)` etc. and the change applies site-wide.",
  schema: updateThemeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tokens"],
    properties: {
      tokens: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Read existing items, merge by token, write back.
    const existing = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.get", {
      kind: "theme",
      slug: "site",
    });
    const prevItems: ThemeTokenItem[] = existing.ok
      ? (((existing.value as { set: { items: unknown } | null }).set?.items as ThemeTokenItem[]) ??
        [])
      : [];
    const byToken = new Map<string, ThemeTokenItem>();
    for (const it of prevItems) byToken.set(it.token, it);
    for (const [rawKey, value] of Object.entries(input.tokens)) {
      const token = camelToKebab(rawKey);
      const scope = inferScope(token);
      byToken.set(token, scope ? { token, value, scope } : { token, value });
    }
    const items = Array.from(byToken.values());
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.set", {
      kind: "theme",
      slug: "site",
      displayName: "Site theme",
      items,
    });
    if (!r.ok)
      return { ok: false, content: `structured_sets.set failed: ${describeError(r.error)}` };
    return {
      ok: true,
      content: `theme updated; ${Object.keys(input.tokens).length} token${Object.keys(input.tokens).length === 1 ? "" : "s"} merged (total now ${items.length})`,
    };
  },
};

// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: list_themes. Thin read over `themes.list`.
 * The system-prompt `## Theme` block already names the active theme
 * at session start; this tool fetches the full list (active + variants)
 * so the AI can pick a target slug when the operator asks to activate
 * or edit a non-active theme.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listThemesToolInput = z.object({}).strict();
type ListThemesToolInput = z.infer<typeof listThemesToolInput>;

interface ThemeRow {
  id: string;
  slug: string;
  displayName: string;
  isActive: boolean;
}

export const listThemesTool: ToolDefinitionWithHandler<ListThemesToolInput> = {
  name: "list_themes",
  description:
    "List every theme on this site (one row is active; the rest are variants). " +
    "Returns each theme's id (UUID), slug, displayName, and isActive flag. Use when the operator " +
    "mentions a theme by name and you need its slug or id — the id is what `propose_activate_theme` " +
    "takes as `themeId`, so you can activate a variant straight from this list without a get_theme " +
    "round-trip.",
  schema: listThemesToolInput,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.list", input);
    if (!r.ok) return { ok: false, content: `themes.list failed: ${describeError(r.error)}` };
    const themes = (r.value as { themes: ThemeRow[] }).themes;
    if (themes.length === 0) {
      return { ok: true, content: "No themes on this site yet." };
    }
    // issue #106 (step-13 deviation) — surface the id. `propose_activate_theme`
    // requires the theme UUID; omitting it here forced the AI into an extra
    // get_theme / DTCG read just to learn the id of a theme it had just listed.
    const lines = themes.map(
      (t) => `- ${t.slug} ("${t.displayName}")${t.isActive ? " [active]" : ""} — id ${t.id}`,
    );
    return { ok: true, content: lines.join("\n") };
  },
};

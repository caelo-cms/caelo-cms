// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `set_nav_menu`. Convenience wrapper over the generic
 * `set_structured_set` tool, scoped to the `nav-menu` kind. Users say
 * "edit the menu", not "set the structured set kind=nav-menu" — the
 * AI was picking the right tool but the friendlier name avoids
 * misfires when the user references a menu by display name.
 *
 * Items shape (per `navMenuItem` in @caelo/shared/structured-sets):
 *   { label, href, target?: '_self'|'_blank', children?: NavItem[],
 *     adSlotId? }
 *
 * Per-kind Zod validation runs inside `structured_sets.set` — this
 * tool just forwards the items array.
 */

import { execute } from "@caelo/query-api";
import { setNavMenuToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setNavMenuTool: ToolDefinitionWithHandler<
  import("@caelo/shared").SetNavMenuToolInput
> = {
  name: "set_nav_menu",
  description:
    "Replace a navigation menu's items by slug (kind = 'nav-menu'). " +
    "Use when the user says 'edit the header menu', 'add a Pricing link to the nav', or 'remove About from the footer menu'. " +
    "Pass the FULL desired item list — the op replaces the menu, not appends. " +
    "Item shape: { label, href, target?, children?, adSlotId? }. " +
    "Common slugs: header-main, footer-main. " +
    "For non-menu structured sets (taxonomies, tags, link lists, theme tokens), use `set_structured_set` instead.",
  schema: setNavMenuToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "items"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      items: { type: "array" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.set", {
      kind: "nav-menu",
      slug: input.slug,
      displayName: input.displayName,
      items: input.items,
    });
    if (!res.ok) {
      return { ok: false, content: `structured_sets.set failed: ${describeError(res.error)}` };
    }
    return {
      ok: true,
      content: `nav menu "${input.slug}" updated with ${input.items.length} item(s)`,
    };
  },
};

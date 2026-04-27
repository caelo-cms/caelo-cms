// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_structured_set. The single tool that handles every kind
 * of structured-data set: nav-menu, taxonomy, theme, tags, link-list.
 * Per-kind Zod validation runs in `structured_sets.set` (it imports the
 * same per-kind schemas this tool's input declares).
 *
 * For nav-menu specifically, the renderer in `composePagePreview`
 * checks whether a module's slug starts with `nav-menu-` and if so
 * emits the live menu HTML composed from the matching set's items.
 * Adding a new menu typically means: (1) `set_structured_set` to
 * persist the items, then (2) `add_module_to_template` (or
 * `add_module_to_page`) with a slug like `nav-menu-header-main` so the
 * renderer picks it up. The dev-owner seed already places header +
 * footer modules so most sessions skip step 2.
 */

import { execute } from "@caelo/query-api";
import { setStructuredSetToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setStructuredSetTool: ToolDefinitionWithHandler<
  import("@caelo/shared").SetStructuredSetToolInput
> = {
  name: "set_structured_set",
  description:
    "Replace the items of a named structured-data set (nav-menu, taxonomy, theme, tags, or link-list). " +
    "Use `kind=nav-menu slug=header-main` to set the site header navigation; `kind=tags slug=blog` for blog tags; etc. " +
    "Item shape is per-kind — see the structured-set schemas in the system prompt.",
  schema: setStructuredSetToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "slug", "displayName", "items"],
    properties: {
      kind: { type: "string", enum: ["nav-menu", "taxonomy", "theme", "tags", "link-list"] },
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      items: { type: "array" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.set", input);
    if (!r.ok)
      return { ok: false, content: `structured_sets.set failed: ${describeError(r.error)}` };
    return {
      ok: true,
      content: `${input.kind}/${input.slug} updated with ${input.items.length} item${input.items.length === 1 ? "" : "s"}`,
    };
  },
};

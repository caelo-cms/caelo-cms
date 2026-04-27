// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — `create_layout`. Owner-only at the op level: AI calls reject
 * with ActorScopeRejected, the chat surfaces a clear permission message,
 * and the AI offers to either ping the Owner or use an existing layout.
 *
 * Why this tool exists at all: the AI needs to recognize the user's
 * intent ("I want a campaign layout with a top banner") and explain
 * the permission gate, rather than silently picking the wrong tool.
 */

import { execute } from "@caelo/query-api";
import { createLayoutToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createLayoutTool: ToolDefinitionWithHandler<
  import("@caelo/shared").CreateLayoutToolInput
> = {
  name: "create_layout",
  description:
    "Create a brand-new layout (site shell). Owner-only — AI calls reject with a permission message; the user must " +
    "create new layouts via /security/layouts. Use this tool only to *propose* — when the user wants a chrome variant " +
    'that none of the existing layouts cover (e.g. "a campaign layout with a banner and no footer"). ' +
    "On rejection, suggest the user create it via /security/layouts and offer to bind a template to it once it exists.",
  schema: createLayoutToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "html", "blocks"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName", "position"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            position: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.create", {
      slug: input.slug,
      displayName: input.displayName,
      html: input.html,
      css: input.css ?? "",
      blocks: input.blocks,
    });
    if (!res.ok) {
      const reason = describeError(res.error);
      const errKind = (res.error as { kind?: string }).kind;
      if (errKind === "ActorScopeRejected") {
        return {
          ok: false,
          content:
            "creating new layouts requires Owner permission. Ask an Owner to create the layout via /security/layouts; " +
            "I can then bind a template to it via set_template_layout, or add modules to its blocks via add_module_to_layout.",
        };
      }
      return { ok: false, content: `layouts.create failed: ${reason}` };
    }
    const layoutId = (res.value as { layoutId: string }).layoutId;
    return {
      ok: true,
      content: `layout ${layoutId} (slug=${input.slug}) created with ${input.blocks.length} block(s)`,
    };
  },
};

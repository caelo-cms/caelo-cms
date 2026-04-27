// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — `remove_module_from_layout`. Detaches a module from every
 * block it appears in on the named layout. Does NOT delete the module
 * itself (the module may also be in use on a page or template) — just
 * removes the layout-level attachments.
 */

import { execute } from "@caelo/query-api";
import { removeModuleFromLayoutToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface LayoutDetail {
  id: string;
  slug: string;
  blocks: { name: string; displayName: string; position: number }[];
}

export const removeModuleFromLayoutTool: ToolDefinitionWithHandler<
  import("@caelo/shared").RemoveModuleFromLayoutToolInput
> = {
  name: "remove_module_from_layout",
  description:
    "Detach a module from every block on a layout. The module itself is not deleted; only the layout-level attachments. " +
    "Use to remove site-wide chrome ('remove the footer from every page'). The user must already know the moduleId — " +
    "find it via the Layouts block in the system prompt or by asking.",
  schema: removeModuleFromLayoutToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["layoutSlug", "moduleId"],
    properties: {
      layoutSlug: { type: "string", minLength: 1, maxLength: 120 },
      moduleId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", {
      slug: input.layoutSlug,
    });
    if (!got.ok) {
      return { ok: false, content: `layouts.get failed: ${describeError(got.error)}` };
    }
    const layout = (got.value as { layout: LayoutDetail | null }).layout;
    if (!layout) {
      return { ok: false, content: `layout "${input.layoutSlug}" not found` };
    }
    let removed = 0;
    for (const block of layout.blocks) {
      const existing = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.get", {
        layoutId: layout.id,
        blockName: block.name,
      });
      if (!existing.ok) continue;
      const ids = (existing.value as { moduleIds: string[] }).moduleIds;
      if (!ids.includes(input.moduleId)) continue;
      const next = ids.filter((id) => id !== input.moduleId);
      const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.set", {
        layoutId: layout.id,
        blockName: block.name,
        moduleIds: next,
      });
      if (setRes.ok) removed += 1;
    }
    if (removed === 0) {
      return {
        ok: false,
        content: `module ${input.moduleId} not attached to any block on layout "${input.layoutSlug}"`,
      };
    }
    return {
      ok: true,
      content: `module ${input.moduleId} detached from ${removed} block(s) on layout "${layout.slug}"`,
    };
  },
};

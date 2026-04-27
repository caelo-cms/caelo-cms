// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: remove_module_from_page. Splices one moduleId out of a
 * page's block layout via `pages.set_modules`. Round-trips through
 * pages.get_with_modules → splice → set_modules so the existing
 * snapshot + audit path covers the change.
 *
 * Removing the module from the page does NOT delete the module row
 * itself — it stays available for re-use elsewhere. To delete the
 * module entirely, the user should use the /content/modules surface.
 */

import { execute } from "@caelo/query-api";
import { removeModuleFromPageToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

export const removeModuleFromPageTool: ToolDefinitionWithHandler<
  import("@caelo/shared").RemoveModuleFromPageToolInput
> = {
  name: "remove_module_from_page",
  description:
    "Remove a module from a page's layout. The module row stays — only the page-level reference is dropped. " +
    "To replace a module with new content, prefer `edit_module` (keeps the existing slot) over remove + add.",
  schema: removeModuleFromPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "moduleId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      moduleId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok)
      return { ok: false, content: `pages.get_with_modules failed: ${describeError(got.error)}` };
    const page = (got.value as { page: PageWithModules }).page;
    let removed = false;
    const blocks = page.blocks.map((b) => {
      const before = b.modules.length;
      const moduleIds = b.modules.map((m) => m.moduleId).filter((id) => id !== input.moduleId);
      if (moduleIds.length !== before) removed = true;
      return { blockName: b.blockName, moduleIds };
    });
    if (!removed) {
      return { ok: false, content: `module ${input.moduleId} is not on page ${input.pageId}` };
    }
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!r.ok) return { ok: false, content: `pages.set_modules failed: ${describeError(r.error)}` };
    return { ok: true, content: `module ${input.moduleId} removed from page ${input.pageId}` };
  },
};

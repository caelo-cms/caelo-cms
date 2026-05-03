// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `reorder_module`. Changes a module's position within its
 * current block. Pass `up` / `down` to shift one slot, or an integer
 * for an absolute 0-based target index. Same splice pattern as
 * move_module but constrained to the source block.
 */

import { execute } from "@caelo-cms/query-api";
import { reorderModuleToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

export const reorderModuleTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ReorderModuleToolInput
> = {
  name: "reorder_module",
  description:
    "Change a module's position within its current block. " +
    "Use when the user says 'move the testimonials above the gallery' or 'put the hero last'. " +
    "For moving across blocks (e.g. content → header), use `move_module` instead.",
  schema: reorderModuleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "moduleId", "direction"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      moduleId: { type: "string", format: "uuid" },
      direction: {
        oneOf: [
          { type: "string", enum: ["up", "down"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok) {
      return { ok: false, content: `pages.get_with_modules failed: ${describeError(got.error)}` };
    }
    const detail = (got.value as { page: PageWithModules }).page;
    let block: { blockName: string; ids: string[] } | null = null;
    for (const b of detail.blocks) {
      const ids = b.modules.map((m) => m.moduleId);
      if (ids.includes(input.moduleId)) {
        block = { blockName: b.blockName, ids };
        break;
      }
    }
    if (block === null) {
      return { ok: false, content: `module ${input.moduleId} is not on page ${input.pageId}` };
    }
    const currentIdx = block.ids.indexOf(input.moduleId);
    let targetIdx: number;
    if (input.direction === "up") targetIdx = Math.max(0, currentIdx - 1);
    else if (input.direction === "down") targetIdx = Math.min(block.ids.length - 1, currentIdx + 1);
    else targetIdx = Math.min(input.direction, block.ids.length - 1);
    if (targetIdx === currentIdx) {
      return {
        ok: true,
        content: `module already at position ${currentIdx} in block "${block.blockName}" — no-op`,
      };
    }
    const reordered = [...block.ids];
    reordered.splice(currentIdx, 1);
    reordered.splice(targetIdx, 0, input.moduleId);
    const blocks = detail.blocks.map((b) =>
      b.blockName === block.blockName
        ? { blockName: b.blockName, moduleIds: reordered }
        : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
    );
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return { ok: false, content: `pages.set_modules failed: ${describeError(setRes.error)}` };
    }
    return {
      ok: true,
      content: `reordered module in "${block.blockName}" from position ${currentIdx} to ${targetIdx}`,
    };
  },
};

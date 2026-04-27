// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `move_module`. Splices a module from its current block to
 * `toBlockName` at `position`. Reads pages.get_with_modules → mutates
 * the in-memory blocks list → calls pages.set_modules (same pattern
 * as add/remove). The destination block must exist on the page's
 * template; the validator inside set_modules surfaces a clear error
 * if not.
 */

import { execute } from "@caelo/query-api";
import { moveModuleToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

export const moveModuleTool: ToolDefinitionWithHandler<
  import("@caelo/shared").MoveModuleToolInput
> = {
  name: "move_module",
  description:
    "Move a module from its current block to a different block on the same page. " +
    "Use when the user says 'move the hero into the header' or 'put this banner above the footer'. " +
    "For changing order within the same block, use `reorder_module` instead.",
  schema: moveModuleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "moduleId", "toBlockName", "position"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      moduleId: { type: "string", format: "uuid" },
      toBlockName: { type: "string", minLength: 1, maxLength: 80 },
      position: {
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
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
    let fromBlock: string | null = null;
    for (const b of detail.blocks) {
      if (b.modules.some((m) => m.moduleId === input.moduleId)) {
        fromBlock = b.blockName;
        break;
      }
    }
    if (fromBlock === null) {
      return {
        ok: false,
        content: `module ${input.moduleId} is not on page ${input.pageId}`,
      };
    }
    if (fromBlock === input.toBlockName) {
      return {
        ok: false,
        content: `module is already in block "${input.toBlockName}" — use reorder_module to change its position within the block`,
      };
    }
    const blocks = detail.blocks.map((b) => {
      if (b.blockName === fromBlock) {
        return {
          blockName: b.blockName,
          moduleIds: b.modules.map((m) => m.moduleId).filter((id) => id !== input.moduleId),
        };
      }
      if (b.blockName === input.toBlockName) {
        const ids = b.modules.map((m) => m.moduleId);
        const insertIdx =
          input.position === "top"
            ? 0
            : input.position === "bottom"
              ? ids.length
              : Math.min(input.position, ids.length);
        return {
          blockName: b.blockName,
          moduleIds: [...ids.slice(0, insertIdx), input.moduleId, ...ids.slice(insertIdx)],
        };
      }
      return {
        blockName: b.blockName,
        moduleIds: b.modules.map((m) => m.moduleId),
      };
    });
    // If the destination block isn't currently on the page (no modules
    // there yet), set_modules's template-block check will accept it;
    // we add a fresh entry so the splice persists.
    if (!blocks.some((b) => b.blockName === input.toBlockName)) {
      blocks.push({ blockName: input.toBlockName, moduleIds: [input.moduleId] });
    }
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return { ok: false, content: `pages.set_modules failed: ${describeError(setRes.error)}` };
    }
    return {
      ok: true,
      content: `moved module ${input.moduleId} from "${fromBlock}" to "${input.toBlockName}"`,
    };
  },
};

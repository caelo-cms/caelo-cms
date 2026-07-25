// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `move_module`. Splices a module from its current block to
 * `toBlockName` at `position`. Reads pages.get_with_modules → mutates
 * the in-memory blocks list → calls pages.set_modules (same pattern
 * as add/remove). The destination block must exist on the page's
 * template; the validator inside set_modules surfaces a clear error
 * if not.
 */

import { execute } from "@caelo-cms/query-api";
import { moveModuleToolInput } from "@caelo-cms/shared";
import { blockNotFoundError } from "./_block-name-enum.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

/**
 * Static JSON Schema for the provider. `describeSchema` clones this
 * per-turn and pins `toBlockName` to an enum of the focused page's real
 * blocks (issue #106), so the AI can't move a module into a block that
 * doesn't exist.
 */
const MOVE_MODULE_INPUT_SCHEMA: Record<string, unknown> = {
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
};

export const moveModuleTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").MoveModuleToolInput
> = {
  name: "move_module",
  description:
    "Move a module to a block on the same page, at a position. " +
    "Use when the user says 'move the hero into the header' or 'put this banner above the footer'. " +
    "If `toBlockName` is the module's CURRENT block this performs an in-place reorder (same effect as reorder_module), so you don't need a separate call.",
  schema: moveModuleToolInput,
  inputSchema: MOVE_MODULE_INPUT_SCHEMA,
  // 2026-07 — STATIC on purpose (prompt-cache): the per-turn blockName
  // enum busted Anthropic's tools-prefix cache on every page switch.
  // The valid set is in `# Current page`; a mismatch returns
  // blockNotFoundError naming the choices.
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
    // A move whose target block IS the current block is just a reorder — do it
    // in place instead of bouncing the AI to reorder_module (§11: no forced
    // round-trip). The block mapping below removes-then-reinserts so this is a
    // clean reposition, not a duplicate.
    const sameBlock = fromBlock === input.toBlockName;
    // v0.12.3 (issue #106) — pages.get_with_modules returns ALL template
    // blocks (incl. empty ones), so a toBlockName absent from this list is
    // genuinely not a slot on the page's template. Fail loud + AI-actionable
    // here (matching add_module_to_page) instead of pushing a phantom block
    // and leaning on pages.set_modules' generic rejection. Defense-in-depth:
    // set_modules still validates too.
    if (!detail.blocks.some((b) => b.blockName === input.toBlockName)) {
      return blockNotFoundError({
        blockName: input.toBlockName,
        blockNames: detail.blocks.map((b) => b.blockName),
        pageId: input.pageId,
        argName: "toBlockName",
      });
    }
    const blocks = detail.blocks.map((b) => {
      if (b.blockName === input.toBlockName) {
        // Insert at the requested position. For a same-block move, first drop
        // the module from its current slot so the reinsert is a reposition,
        // not a duplicate (when the blocks differ it isn't here anyway).
        const base = b.modules.map((m) => m.moduleId).filter((id) => id !== input.moduleId);
        const insertIdx =
          input.position === "top"
            ? 0
            : input.position === "bottom"
              ? base.length
              : Math.min(input.position, base.length);
        return {
          blockName: b.blockName,
          moduleIds: [...base.slice(0, insertIdx), input.moduleId, ...base.slice(insertIdx)],
        };
      }
      if (b.blockName === fromBlock) {
        return {
          blockName: b.blockName,
          moduleIds: b.modules.map((m) => m.moduleId).filter((id) => id !== input.moduleId),
        };
      }
      return {
        blockName: b.blockName,
        moduleIds: b.modules.map((m) => m.moduleId),
      };
    });
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return { ok: false, content: `pages.set_modules failed: ${describeError(setRes.error)}` };
    }
    return {
      ok: true,
      content: sameBlock
        ? `reordered module ${input.moduleId} within block "${input.toBlockName}" to position ${input.position}`
        : `moved module ${input.moduleId} from "${fromBlock}" to "${input.toBlockName}"`,
    };
  },
};

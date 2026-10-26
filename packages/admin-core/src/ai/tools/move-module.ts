// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `move_module`. Repositions a module on a page: into another
 * block, or within its current block (the former reorder_module is the
 * `toBlockName`-omitted case; retired-tools.ts maps old calls here). Reads
 * pages.get_with_modules → mutates the in-memory blocks list → calls
 * pages.set_modules (same pattern as add/remove). The destination block
 * must exist on the page's template; the validator inside set_modules
 * surfaces a clear error if not.
 */

import { execute } from "@caelo-cms/query-api";
import { type MoveModuleToolInput, moveModuleToolInput } from "@caelo-cms/shared";
import { blockNotFoundError } from "./_block-name-enum.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

/**
 * Static JSON Schema for the provider. STATIC on purpose (prompt cache): a
 * per-turn `toBlockName` enum busted Anthropic's tools-prefix cache on every
 * page switch; a wrong block returns blockNotFoundError naming the choices.
 */
const MOVE_MODULE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["pageId", "moduleId", "position"],
  properties: {
    pageId: { type: "string", format: "uuid" },
    moduleId: { type: "string", format: "uuid" },
    toBlockName: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "Target block; omit to stay in the module's current block (reorder).",
    },
    position: {
      oneOf: [
        { type: "string", enum: ["top", "bottom", "up", "down"] },
        { type: "integer", minimum: 0, maximum: 1000 },
      ],
      description:
        "0-based index in the target block (clamped to its end). `up`/`down` = one slot, current block only.",
    },
  },
};

/**
 * Index the module lands at in `base` (the target block's ids WITHOUT the
 * module). `up` / `down` are relative to `currentIdx`, the module's index in
 * its current block (same block — the handler refuses them otherwise); an
 * integer is absolute, clamped to the block end.
 */
export function targetIndex(
  position: MoveModuleToolInput["position"],
  currentIdx: number,
  baseLength: number,
): number {
  if (position === "top") return 0;
  if (position === "bottom") return baseLength;
  if (position === "up") return Math.max(0, currentIdx - 1);
  if (position === "down") return Math.min(baseLength, currentIdx + 1);
  return Math.min(position, baseLength);
}

export const moveModuleTool: ToolDefinitionWithHandler<MoveModuleToolInput> = {
  name: "move_module",
  description:
    "Reposition a module on its page: into another block ('move the hero into the header', 'put this banner above the footer') or within its current block ('move the testimonials above the gallery', 'put the hero last' — omit `toBlockName`). Already in place -> no-op.",
  schema: moveModuleToolInput,
  inputSchema: MOVE_MODULE_INPUT_SCHEMA,
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok) {
      return { ok: false, content: `pages.get_with_modules failed: ${describeError(got.error)}` };
    }
    const detail = (got.value as { page: PageWithModules }).page;
    const from = detail.blocks.find((b) => b.modules.some((m) => m.moduleId === input.moduleId));
    if (!from) {
      return {
        ok: false,
        content: `module ${input.moduleId} is not on page ${input.pageId}`,
      };
    }
    const fromBlock = from.blockName;
    const toBlock = input.toBlockName ?? fromBlock;
    // v0.12.3 (issue #106) — pages.get_with_modules returns ALL template
    // blocks (incl. empty ones), so a toBlockName absent from this list is
    // genuinely not a slot on the page's template. Fail loud + AI-actionable
    // here instead of pushing a phantom block and leaning on
    // pages.set_modules' generic rejection (which still validates too).
    const target = detail.blocks.find((b) => b.blockName === toBlock);
    if (!target) {
      return blockNotFoundError({
        blockName: toBlock,
        blockNames: detail.blocks.map((b) => b.blockName),
        pageId: input.pageId,
        argName: "toBlockName",
      });
    }
    const sameBlock = fromBlock === toBlock;
    if (!sameBlock && (input.position === "up" || input.position === "down")) {
      return {
        ok: false,
        content: `position "${input.position}" moves one slot within the module's current block ("${fromBlock}"); for block "${toBlock}" pass "top", "bottom" or a 0-based index — or omit toBlockName to stay in "${fromBlock}".`,
      };
    }
    const currentIds = from.modules.map((m) => m.moduleId);
    const currentIdx = currentIds.indexOf(input.moduleId);
    const base = target.modules.map((m) => m.moduleId).filter((id) => id !== input.moduleId);
    const insertIdx = targetIndex(input.position, currentIdx, base.length);
    if (sameBlock && insertIdx === currentIdx) {
      return {
        ok: true,
        content: `module already at position ${currentIdx} in block "${fromBlock}" — no-op`,
      };
    }
    const blocks = detail.blocks.map((b) => {
      if (b.blockName === toBlock) {
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
      return { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) };
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
        ? `reordered module ${input.moduleId} in block "${fromBlock}" from position ${currentIdx} to ${insertIdx}`
        : `moved module ${input.moduleId} from "${fromBlock}" to "${toBlock}" at position ${insertIdx}`,
    };
  },
};

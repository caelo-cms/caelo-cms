// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `move_module`. Repositions a module on a page: into another
 * block, or within its current block (the former reorder_module is the
 * `toBlockName`-omitted case; retired-tools.ts maps old calls here). Reads
 * pages.get_with_modules → mutates the in-memory blocks list → calls
 * pages.set_modules (same pattern as add/remove). The destination block
 * must exist on the page's template; the validator inside set_modules
 * surfaces a clear error if not.
 *
 * #1195 — it moves ONE placement, addressed by block + position when the
 * module sits on the page more than once, and hands set_modules every
 * placement's content instance. Filtering by moduleId removed the
 * module's other placements in the source and target block, and a
 * cross-block move re-bound the moved placement to fresh empty content.
 */

import { execute } from "@caelo-cms/query-api";
import { type MoveModuleToolInput, moveModuleToolInput } from "@caelo-cms/shared";
import { blockNotFoundError } from "./_block-name-enum.js";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  blocks: {
    blockName: string;
    modules: { moduleId: string; contentInstanceId?: string | null }[];
  }[];
}

/** One placement on the page, as set_modules takes it back. */
interface Placement {
  readonly moduleId: string;
  readonly contentInstanceId: string | null;
}

/** "block "content" position 2" for each placement of the module. */
function describePlacements(found: readonly { blockName: string; index: number }[]): string {
  return found.map((p) => `block "${p.blockName}" position ${p.index}`).join(", ");
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
    fromBlockName: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "With `fromPosition`: which placement, when the module is on the page twice+.",
    },
    fromPosition: { type: "integer", minimum: 0, maximum: 1000 },
    toBlockName: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "Target block; omit to reorder within the current block.",
    },
    position: {
      oneOf: [
        { type: "string", enum: ["top", "bottom", "up", "down"] },
        { type: "integer", minimum: 0, maximum: 1000 },
      ],
      description:
        "0-based index (clamped to the block end). `up`/`down` = one slot, current block only.",
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
    "Reposition a module on its page: into another block ('move the hero into the header', 'put this banner above the footer') or within its block ('move the testimonials above the gallery', 'put the hero last' — omit `toBlockName`). Moves one placement with its content; a module placed twice+ needs `fromBlockName` + `fromPosition`. Already in place -> no-op.",
  schema: moveModuleToolInput,
  inputSchema: MOVE_MODULE_INPUT_SCHEMA,
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok) {
      return toolError(got.error, `pages.get_with_modules failed: ${describeError(got.error)}`);
    }
    const detail = (got.value as { page: PageWithModules }).page;
    const placementsOf = (b: PageWithModules["blocks"][number]): Placement[] =>
      b.modules.map((m) => ({
        moduleId: m.moduleId,
        contentInstanceId: m.contentInstanceId ?? null,
      }));
    const found = detail.blocks.flatMap((b) =>
      b.modules.flatMap((m, index) =>
        m.moduleId === input.moduleId ? [{ blockName: b.blockName, index }] : [],
      ),
    );
    if (found.length === 0) {
      return {
        ok: false,
        content: `module ${input.moduleId} is not on page ${input.pageId}`,
      };
    }
    const addressed = found.filter(
      (p) =>
        (input.fromBlockName === undefined || p.blockName === input.fromBlockName) &&
        (input.fromPosition === undefined || p.index === input.fromPosition),
    );
    const isAddressed = input.fromBlockName !== undefined || input.fromPosition !== undefined;
    if (addressed.length !== 1 || (found.length > 1 && !isAddressed)) {
      return {
        ok: false,
        content:
          addressed.length === 0
            ? `module ${input.moduleId} has no placement at ${[
                input.fromBlockName !== undefined ? `block "${input.fromBlockName}"` : "",
                input.fromPosition !== undefined ? `position ${input.fromPosition}` : "",
              ]
                .filter((x) => x !== "")
                .join(
                  " ",
                )} — its placements: ${describePlacements(found)}. Set fromBlockName + fromPosition to one of them.`
            : `module ${input.moduleId} is placed ${found.length} times on page ${input.pageId} (${describePlacements(found)}) — pass fromBlockName + fromPosition to say which one to move.`,
      };
    }
    const source = addressed[0] as { blockName: string; index: number };
    const fromBlock = source.blockName;
    const currentIdx = source.index;
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
    const fromPlacements = placementsOf(
      detail.blocks.find((b) => b.blockName === fromBlock) as PageWithModules["blocks"][number],
    );
    const moving = fromPlacements[currentIdx] as Placement;
    // The target block without the moving placement — only that one.
    const base = placementsOf(target).filter((_, i) => !(sameBlock && i === currentIdx));
    const insertIdx = targetIndex(input.position, currentIdx, base.length);
    if (sameBlock && insertIdx === currentIdx) {
      return {
        ok: true,
        content: `module already at position ${currentIdx} in block "${fromBlock}" — no-op`,
      };
    }
    const toSetModules = (blockName: string, placements: readonly Placement[]) => ({
      blockName,
      moduleIds: placements.map((p) => p.moduleId),
      contentInstanceIds: placements.map((p) => p.contentInstanceId),
    });
    const blocks = detail.blocks.map((b) => {
      if (b.blockName === toBlock) {
        return toSetModules(b.blockName, [
          ...base.slice(0, insertIdx),
          moving,
          ...base.slice(insertIdx),
        ]);
      }
      if (b.blockName === fromBlock) {
        return toSetModules(
          b.blockName,
          fromPlacements.filter((_, i) => i !== currentIdx),
        );
      }
      return toSetModules(b.blockName, placementsOf(b));
    });
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return toolError(setRes.error, `pages.set_modules failed: ${describeError(setRes.error)}`);
    }
    return {
      ok: true,
      content: sameBlock
        ? `reordered module ${input.moduleId} in block "${fromBlock}" from position ${currentIdx} to ${insertIdx}`
        : `moved module ${input.moduleId} from "${fromBlock}" to "${toBlock}" at position ${insertIdx}`,
    };
  },
};

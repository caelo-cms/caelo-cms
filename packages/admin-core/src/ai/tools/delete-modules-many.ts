// SPDX-License-Identifier: MPL-2.0

/**
 * `delete_modules_many` — retire modules the site no longer uses, in one
 * call (`modules.delete_many`; one module = a one-item array, CLAUDE.md §11
 * bulk-first).
 *
 * Safe by construction, at the op (so the Power-MCP surface inherits it):
 *   - inside a chat the delete is BRANCHED — the live module stays until the
 *     operator publishes, and chat-keyed Undo restores it;
 *   - an AI actor cannot delete a module that is still placed on a page or
 *     layout (as this chat sees them) — the op refuses it and names the
 *     placements, so the AI unplaces it with `remove_module_from` first.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const deleteModulesManyInput = z
  .object({
    moduleIds: z
      .array(z.string().uuid())
      .min(1)
      .max(200)
      .describe("Module ids from list_modules. One module = a one-item array."),
  })
  .strict();

type DeleteModulesManyInput = z.infer<typeof deleteModulesManyInput>;

export const deleteModulesManyTool: ToolDefinitionWithHandler<DeleteModulesManyInput> = {
  name: "delete_modules_many",
  description:
    "Delete modules that are no longer placed anywhere, in ONE call (one module = a one-item array; up to 200). Take ids from `list_modules` — its usage column shows which modules are unplaced. " +
    "A module still placed on a page or layout is refused (nothing is deleted for it) and the result names where it is used: unplace it with `remove_module_from` first, or keep it. " +
    "Use it to clean up after a redesign or migration ('remove the old hero variants', 'delete unused imported modules'). Deletes land on this chat's preview like any other edit and reach the live site when the operator publishes; Undo restores them. " +
    "To take a module off one page but keep it for reuse, use `remove_module_from` instead — that does not delete the module.",
  schema: deleteModulesManyInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.delete_many", {
      moduleIds: input.moduleIds,
    });
    if (!r.ok) {
      return { ok: false, content: `modules.delete_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      deleted: number;
      alreadyDeleted: number;
      notFound: number;
      refused: { moduleId: string; reason: string }[];
    };
    const parts = [`Deleted ${v.deleted} module(s).`];
    if (v.alreadyDeleted > 0) parts.push(`${v.alreadyDeleted} were already deleted.`);
    if (v.notFound > 0) {
      parts.push(`${v.notFound} id(s) not found — re-check them with list_modules.`);
    }
    if (v.refused.length > 0) {
      parts.push(
        `Not deleted:\n${v.refused.map((x) => `  ${x.moduleId}: ${x.reason}`).join("\n")}`,
      );
    }
    return { ok: v.deleted > 0 || v.alreadyDeleted > 0, content: parts.join("\n"), value: v };
  },
};

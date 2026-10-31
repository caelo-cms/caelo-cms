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
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const deleteModulesManyInput = z
  .object({
    moduleIds: z
      .array(z.string().uuid())
      .min(1)
      .max(200)
      .describe("From `list_modules` (its usage column shows unplaced ones)."),
  })
  .strict();

type DeleteModulesManyInput = z.infer<typeof deleteModulesManyInput>;

export const deleteModulesManyTool: ToolDefinitionWithHandler<DeleteModulesManyInput> = {
  name: "delete_modules_many",
  description:
    "Delete modules no longer placed anywhere (cleanup after a redesign/migration). A still-placed module is refused (not deleted) and the result names where it is used: unplace via `remove_module_from` first, or keep it. Lands on the chat preview, live on publish; Undo restores. " +
    "To take a module off one page but keep it -> `remove_module_from`.",
  schema: deleteModulesManyInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.delete_many", {
      moduleIds: input.moduleIds,
    });
    if (!r.ok) {
      return toolError(r.error, `modules.delete_many failed: ${describeError(r.error)}`);
    }
    const v = r.value as {
      deleted: number;
      alreadyDeleted: number;
      notFound: number;
      refused: { moduleId: string; reason: string; refusal: boolean }[];
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
    const ok = v.deleted > 0 || v.alreadyDeleted > 0;
    // #1091 — nothing deleted only because the in-use guard refused every
    // id: the tool working as designed (the result names the fix), not a
    // defect. A lock conflict or an unknown id still counts as a failure.
    const onlyGuarded =
      !ok && v.notFound === 0 && v.refused.length > 0 && v.refused.every((x) => x.refusal);
    return {
      ok,
      content: parts.join("\n"),
      value: v,
      ...(onlyGuarded ? { refusal: true as const } : {}),
    };
  },
};

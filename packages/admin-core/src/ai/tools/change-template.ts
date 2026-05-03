// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `change_template`. Re-points a page's templateId, migrating
 * modules where the old + new template share block names. Modules in
 * orphaned blocks (block name not present on the new template) are
 * either dropped or relocated to a designated block per
 * `orphanDisposition`. Returns the migrated + dropped lists so the
 * tool result the AI surfaces is concrete ("3 modules migrated, 1
 * dropped from `sidebar`"), not vague.
 *
 * Tool guidance: when the diff would drop modules, the AI should ASK
 * the user before passing `kind: "drop"` — the safe default for
 * unconfirmed ambiguity is to read the current template's blocks
 * (via pages.get_with_modules) and quote them back.
 */

import { execute } from "@caelo-cms/query-api";
import { changeTemplateToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const changeTemplateTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ChangeTemplateToolInput
> = {
  name: "change_template",
  description:
    "Re-point a page to a different template (page-type). Modules in matching block names migrate; " +
    "modules in unmatched blocks are dropped or moved to a named block per `orphanDisposition`. " +
    "If the change would drop modules, CONFIRM with the user before passing `{ kind: 'drop' }`. " +
    "After the call, surface the returned `migratedBlocks` and `droppedModules` lists in your reply.",
  schema: changeTemplateToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "newTemplateId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      newTemplateId: { type: "string", format: "uuid" },
      orphanDisposition: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: { kind: { type: "string", enum: ["drop"] } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "blockName"],
            properties: {
              kind: { type: "string", enum: ["preserve-as-block"] },
              blockName: { type: "string", minLength: 1, maxLength: 120 },
            },
          },
        ],
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages.change_template",
      input,
    );
    if (!res.ok) {
      return {
        ok: false,
        content: `pages.change_template failed: ${describeError(res.error)}`,
      };
    }
    const out = res.value as {
      migratedBlocks: string[];
      droppedModules: { moduleId: string; formerBlock: string }[];
    };
    const migrated =
      out.migratedBlocks.length > 0
        ? `migrated blocks: ${out.migratedBlocks.join(", ")}`
        : "no blocks migrated (no overlap in block names)";
    const dropped =
      out.droppedModules.length > 0
        ? `dropped ${out.droppedModules.length} module(s): ${out.droppedModules.map((m) => `${m.moduleId} (was in "${m.formerBlock}")`).join("; ")}`
        : "no modules dropped";
    return { ok: true, content: `${migrated}; ${dropped}` };
  },
};

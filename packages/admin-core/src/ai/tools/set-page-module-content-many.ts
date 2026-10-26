// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_page_module_content_many — fills the content values of 1..N
 * placements in ONE transaction (the former singular set_page_module_content
 * is its n=1 case; retired-tools.ts maps old calls here). Page content lives
 * in a content_instance bound to the placement: unsynced placements stay
 * local to their page, synced ones are refused (fork first or edit the
 * shared instance deliberately).
 */

import { execute } from "@caelo-cms/query-api";
import { pageModuleContentSetManySchema } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPageModuleContentManyTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").PageModuleContentSetManyInput
> = {
  name: "set_page_module_content_many",
  description: [
    "Set content values of 1..N placements (may span pages) in one transaction. Content lives in a content_instance bound to the placement.",
    "USE FOR: page-local copy ('change the hero heading on /home to X'), a whole page's text, the same fix across pages.",
    "DO NOT USE FOR: pages/modules not existing yet -> one `build_page` call (never `add_module` + this tool); one entry's text -> `patch_page_module_fields`; every page using the module (structure/styling/fields) -> `update_modules_many`.",
    "CORE RULES:",
    "- UNSYNCED placements (default) stay local. A SYNCED placement aborts the batch -> `fork_placement_content` it or deliberately `set_content_instance_values_many` (propagates everywhere), then resend.",
    "- All-or-nothing: an invalid item aborts the batch (error names `items[i]`, the placement, the failing field); nothing is written.",
    INTERNAL_LINK_CONTRACT,
  ].join("\n"),
  schema: pageModuleContentSetManySchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pageId", "blockName", "position", "contentValues"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            blockName: { type: "string", minLength: 1, maxLength: 80 },
            position: { type: "integer", minimum: 0 },
            contentValues: {
              type: "object",
              additionalProperties: true,
              description:
                "Keyed by the module's field names; fully replaces the placement's values. Missing fields -> the field's `default`; `{}` resets all. " +
                'Local `list` -> entries (`[{node:"text", values:{text:"Fast"}}]`, existing entries keep `id`); shared `list` -> `caelo:list/<id>` switches the list shown (entries change via `patch_list_items_many`, on every page); source field -> editable knobs (`{limit:5}`); ' +
                "nested `module`/`module-list` -> `{moduleId, contentInstanceId}` | array; the module's stable `type` must be in the field's `allowedModuleTypes` when set (`list_modules` shows both).",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "page_module_content.set_many",
      input,
    );
    if (!r.ok) {
      return {
        ok: false,
        content: `page_module_content.set_many failed (whole batch rolled back): ${describeError(r.error)}`,
      };
    }
    const { updated } = r.value as { updated: number };
    return {
      ok: true,
      content: `${updated} placement(s) updated in one transaction.`,
    };
  },
};

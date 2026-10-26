// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: delete_content_instances — soft-deletes 1..N content_instances in
 * one transaction (the former singular delete_content_instance is its n=1
 * case; retired-tools.ts maps old calls here). Built from the `makeBulkTool`
 * factory; dispatches `content_instances.delete_many`. All-or-nothing: if any
 * item still has placements or a parent (or is otherwise refused), the whole
 * batch rolls back and the refusal names the blockers.
 */

import { deleteContentInstanceToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const deleteContentInstancesTool = makeBulkTool({
  name: "delete_content_instances",
  description: [
    "Soft-delete ORPHAN content_instances — one call for 1..N (`items[]`), one transaction. Orphan = zero placements AND no parent instance shows it in a `module`/`module-list` field (`list_content_instances`: placements=0, parents=0).",
    "CORE RULES:",
    "- ANY refused item rolls back the WHOLE batch. The refusal names the blockers:",
    "  - placements (page path, pageId, blockName, position) -> detach each via `fork_placement_content` with those values (the page keeps a private copy), then retry.",
    "  - parents -> remove the ref from each parent's field via `set_content_instance_values_many` first.",
    "- In a chat this lands on the draft; the live site changes when staged.",
  ].join("\n"),
  itemInputSchema: deleteContentInstanceToolInput,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" },
    },
  },
  opName: "content_instances.delete_many",
  formatResult: (_value, input) =>
    `${input.items.length} content_instance(s) soft-deleted: ${input.items.map((i) => i.id).join(", ")}.`,
});

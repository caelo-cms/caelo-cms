// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk variant of `delete_content_instance` — soft-deletes N content_instances
 * in one transaction. Built from the `makeBulkTool` factory; dispatches
 * `content_instances.delete_many`. All-or-nothing: if any item still has
 * placements (or is otherwise refused), the whole batch rolls back.
 */

import { deleteContentInstanceToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const deleteContentInstancesTool = makeBulkTool({
  name: "delete_content_instances",
  description:
    "Soft-delete SEVERAL content_instances in ONE transaction — prefer this over multiple `delete_content_instance` calls whenever you prune more than one (§11 bulk-first). " +
    "Only ORPHAN instances (placementCount=0) can be deleted: if ANY item still has placements the op refuses and the WHOLE batch rolls back (nothing deleted) — detach those placements via `fork_placement_content` first. " +
    "Use `list_content_instances` to find orphans (placementCount=0). Each item is `{id}`.",
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
});

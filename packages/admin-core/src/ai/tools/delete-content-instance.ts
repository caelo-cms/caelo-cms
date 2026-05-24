// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: delete_content_instance. Soft-deletes a
 * content_instance. Refused when N>0 placements still reference the
 * row — call fork_placement_content on each placement first, OR (in
 * v0.12.0.1+) submit a propose_delete_content_instance proposal so the
 * Owner can approve the cascade.
 */

import { execute } from "@caelo-cms/query-api";
import { deleteContentInstanceToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const deleteContentInstanceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").DeleteContentInstanceToolInput
> = {
  name: "delete_content_instance",
  description:
    "Soft-delete a content_instance. Only allowed when ZERO placements still bind to it (orphan instance). " +
    "When placements exist, the op returns an error pointing you at fork_placement_content for each referencing placement. " +
    "Use list_content_instances to find orphan instances (placementCount=0) and prune them.",
  schema: deleteContentInstanceToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "content_instances.delete",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `content_instances.delete failed: ${describeError(r.error)}` };
    }
    return { ok: true, content: `content_instance ${input.id} soft-deleted.` };
  },
};

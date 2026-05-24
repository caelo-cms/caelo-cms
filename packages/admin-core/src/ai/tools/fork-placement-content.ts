// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: fork_placement_content. Detaches a placement
 * from its shared content_instance into a fresh unsynced one (deep
 * copy of the current values). Use when the operator wants to edit
 * this page's content without affecting the other pages bound to the
 * same instance.
 */

import { execute } from "@caelo-cms/query-api";
import { forkPlacementContentToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const forkPlacementContentTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ForkPlacementContentToolInput
> = {
  name: "fork_placement_content",
  description:
    "Detach a placement from its shared content_instance into a fresh unsynced one. Use when the operator wants to edit content on THIS page only, without affecting other pages bound to the same instance. " +
    "After forking, call set_page_module_content (or set_content_instance_values on the new instance) to apply the edit.",
  schema: forkPlacementContentToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "blockName", "position"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: { type: "integer", minimum: 0 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "placement.fork_content",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `placement.fork_content failed: ${describeError(r.error)}` };
    }
    const { contentInstanceId } = r.value as { contentInstanceId: string };
    return {
      ok: true,
      content: `placement ${input.blockName}#${input.position} on page ${input.pageId} forked to new unsynced content_instance ${contentInstanceId}.`,
    };
  },
};

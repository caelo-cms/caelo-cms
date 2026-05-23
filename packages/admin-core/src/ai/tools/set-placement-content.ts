// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: set_placement_content. Bind a placement to a
 * content_instance + choose sync mode.
 *
 *   - sync_mode='synced'   → editing the bound instance propagates to
 *     every other placement bound to the same row. Use for shared
 *     content (header CTA, footer contact info).
 *   - sync_mode='unsynced' → the placement holds a private instance;
 *     edits stay local. Default for "add a new placement".
 *
 * The target content_instance MUST be for the same module as the
 * placement; the op rejects with a clear error otherwise.
 */

import { execute } from "@caelo-cms/query-api";
import { setPlacementContentToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPlacementContentTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetPlacementContentToolInput
> = {
  name: "set_placement_content",
  description:
    "Bind one placement (page + block + position) to a content_instance + choose sync mode. " +
    "Use sync_mode='synced' to make this placement share content with every other placement that binds to the same instance — editing the instance propagates everywhere. " +
    "Use sync_mode='unsynced' for page-local content. " +
    "The content_instance must be for the same module as the placement.",
  schema: setPlacementContentToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "blockName", "position", "contentInstanceId", "syncMode"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: { type: "integer", minimum: 0 },
      contentInstanceId: { type: "string", format: "uuid" },
      syncMode: { type: "string", enum: ["synced", "unsynced"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "placement.set_content",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `placement.set_content failed: ${describeError(r.error)}` };
    }
    const { contentInstanceId } = r.value as { contentInstanceId: string };
    return {
      ok: true,
      content: `placement ${input.blockName}#${input.position} on page ${input.pageId} bound to content_instance ${contentInstanceId} (${input.syncMode}).`,
    };
  },
};

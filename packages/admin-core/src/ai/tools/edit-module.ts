// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: edit_module. Writes one module's HTML/CSS/JS or display name.
 * The only mutation tool the AI gets in P5.
 *
 * Wraps `modules.update` so the existing P3 validation, audit logging,
 * and P4 snapshot emission all flow through unchanged. The handler
 * pushes ctx.chatBranchId into the call so the snapshot lands tagged
 * with the chat's branch — the publish step (P5 chat ops) then re-emits
 * those branch snapshots as main snapshots.
 */

import { execute } from "@caelo/query-api";
import { editModuleToolInput } from "@caelo/shared";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const editModuleTool: ToolDefinitionWithHandler<
  import("@caelo/shared").EditModuleToolInput
> = {
  name: "edit_module",
  description:
    "Edit one module's HTML, CSS, JS, or display name. Pages, templates, and " +
    "cross-module changes use other tools (not yet available in this phase).",
  schema: editModuleToolInput,
  // Hand-aligned JSON Schema mirroring `editModuleToolInput`. Anthropic's
  // tool-use API takes the schema verbatim from this map.
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId"],
    properties: {
      moduleId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      html: { type: "string" },
      css: { type: "string" },
      js: { type: "string" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.update", input);
    if (result.ok) {
      return { ok: true, content: `module ${input.moduleId} updated` };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};

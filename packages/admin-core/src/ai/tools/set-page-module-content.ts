// SPDX-License-Identifier: MPL-2.0

/**
 * v0.4.0 — AI tool: set_page_module_content. Fills the content values for
 * a module placement on one specific page.
 *
 * Companion to `edit_module`:
 *   - `edit_module` changes module STRUCTURE (HTML template, CSS, JS,
 *     field schema). Edits are GLOBAL + IMMEDIATE.
 *   - `set_page_module_content` changes CONTENT for one placement only
 *     (the text the hero says on /home, etc.). Edits are PAGE-BOUND and
 *     BRANCH-ISOLATED per chat — visible only in this chat's preview
 *     until the operator publishes.
 *
 * The tool wraps `page_module_content.set`, which writes a branched
 * snapshot when the caller has a chat branch and updates the live row
 * only at publish time.
 */

import { execute } from "@caelo-cms/query-api";
import { setPageModuleContentToolInput } from "@caelo-cms/shared";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPageModuleContentTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetPageModuleContentToolInput
> = {
  name: "set_page_module_content",
  description:
    "Set the content values for one module placement on a specific page. " +
    "v0.12.0 — page CONTENT lives in a content_instance bound to the placement. " +
    "For UNSYNCED placements (the default) this tool routes through content_instances.set_values and edits stay local to this page. " +
    "For SYNCED placements (sharing content with other pages) this tool refuses and points you at fork_placement_content (to detach first) or set_content_instance_values (to commit to the propagate-everywhere blast radius). " +
    "Use this when the operator says 'change the hero heading on /home to X' or 'set the about page subtitle to Y'. " +
    "Use `edit_module` (NOT this tool) when the change should affect every page using the module (structural / styling / field-schema change). " +
    "`contentValues` is keyed by the module's declared field names (`{{fieldName}}` placeholders). " +
    "For nested fields (kind `module` / `module-list`) the value is `{ moduleId, contentInstanceId }` (or an array of them); the referenced module's stable `type` must be in the field's `allowedModuleTypes` when set (reuse a module of an allowed type — see `## Modules`). " +
    "Missing fields fall back to the module field's `default`. " +
    "Pass an empty object to reset a placement to all defaults.",
  schema: setPageModuleContentToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "blockName", "position", "contentValues"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      blockName: { type: "string", minLength: 1, maxLength: 64 },
      position: { type: "integer", minimum: 0 },
      contentValues: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const result = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "page_module_content.set",
      input,
    );
    if (result.ok) {
      const id = (result.value as { pageModuleContentId: string }).pageModuleContentId;
      return {
        ok: true,
        content: `page content updated for ${input.blockName}#${input.position} on page ${input.pageId} (id=${id})`,
      };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};

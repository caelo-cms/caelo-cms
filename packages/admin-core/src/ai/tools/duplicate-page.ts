// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `duplicate_page`. Clones an existing page (and its module
 * layout) under a new slug. Modules are referenced, not deep-copied:
 * editing one module updates every page that references it. The
 * duplicated page inherits the source page's templateId by default;
 * pass `targetTemplateId` to clone into a different page-type, but
 * note that block names must line up (mismatched names need a
 * follow-up `repoint_page_template` to migrate orphans).
 */

import { execute } from "@caelo-cms/query-api";
import { duplicatePageToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const duplicatePageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").DuplicatePageToolInput
> = {
  name: "duplicate_page",
  description:
    "Clone an existing page under a new slug. Modules are shared by reference (edits propagate to both pages). " +
    "Use when the user says 'make a copy of this page' or 'duplicate the about page'. " +
    "If cloning to a different page-type via `targetTemplateId`, block names must align — if they don't, modules in " +
    "unmatched blocks orphan immediately. Follow up with `repoint_page_template` to migrate or drop those orphans. " +
    "Soft-deleted modules on the source are filtered out at clone time; the audit log surfaces the dropped count.",
  schema: duplicatePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourcePageId", "newSlug"],
    properties: {
      sourcePageId: { type: "string", format: "uuid" },
      newSlug: { type: "string", minLength: 1, maxLength: 120 },
      newName: { type: "string", minLength: 1, maxLength: 256 },
      newTitle: { type: "string", minLength: 1, maxLength: 256 },
      targetTemplateId: { type: "string", format: "uuid" },
      locale: { type: "string", minLength: 2, maxLength: 10 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.duplicate", input);
    if (!res.ok) {
      return { ok: false, content: `pages.duplicate failed: ${describeError(res.error)}` };
    }
    const newPageId = (res.value as { pageId: string }).pageId;
    return {
      ok: true,
      content: `page ${newPageId} cloned with slug=${input.newSlug}; modules carry over by reference (edits propagate to the source)`,
    };
  },
};
